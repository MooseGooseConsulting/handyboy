param([Parameter(Mandatory)][string]$PipeName)
$ErrorActionPreference = 'Stop'
# Node's pipe API cannot supply a DACL at creation. This small stdio bridge uses
# the Windows pipe constructor so every instance is private before accepting.
Add-Type @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading.Tasks;
using System.Collections.Concurrent;
using System.Security.AccessControl;
using System.Security.Principal;
public static class HandyboyPipes {
    static ConcurrentDictionary<int, NamedPipeServerStream> clients = new ConcurrentDictionary<int, NamedPipeServerStream>();
    static object output = new object();
    static int sequence = 0;
    static void Emit(string line) { lock (output) { Console.Out.WriteLine(line); Console.Out.Flush(); } }
    static void Close(int id) {
        NamedPipeServerStream pipe;
        if (clients.TryRemove(id, out pipe)) { pipe.Dispose(); Emit("close " + id); }
    }
    static async Task Read(int id, NamedPipeServerStream pipe) {
        try {
            var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true);
            string line;
            while ((line = await reader.ReadLineAsync()) != null)
                Emit("data " + id + " " + Convert.ToBase64String(Encoding.UTF8.GetBytes(line + "\n")));
        } catch (IOException) { } catch (ObjectDisposedException) { }
        finally { Close(id); }
    }
    static async Task Accept(string name, PipeSecurity security) {
        bool ready = false;
        while (true) {
            var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 254,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security);
            if (!ready) { Emit("ready"); ready = true; }
            await pipe.WaitForConnectionAsync();
            int id = ++sequence;
            clients[id] = pipe;
            Emit("open " + id);
            Task reading = Read(id, pipe).ContinueWith(t => { if (t.IsFaulted) Emit("error client read failed"); });
        }
    }
    public static void Run(string name) {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        Accept(name, security).ContinueWith(t => {
            if (t.IsFaulted) { Emit("error pipe listener failed"); Environment.Exit(1); }
        });
        string line;
        while ((line = Console.In.ReadLine()) != null) {
            string[] parts = line.Split(new char[] { ' ' }, 3);
            int id;
            if (parts.Length < 2 || !Int32.TryParse(parts[1], out id)) continue;
            if (parts[0] == "close") { Close(id); continue; }
            NamedPipeServerStream pipe;
            if (parts[0] == "write" && parts.Length == 3 && clients.TryGetValue(id, out pipe)) {
                try { var bytes = Convert.FromBase64String(parts[2]); pipe.Write(bytes, 0, bytes.Length); pipe.Flush(); }
                catch (IOException) { Close(id); } catch (ObjectDisposedException) { Close(id); }
            }
        }
        foreach (int id in clients.Keys) Close(id);
    }
}
'@ -WarningAction SilentlyContinue
[HandyboyPipes]::Run($PipeName)
