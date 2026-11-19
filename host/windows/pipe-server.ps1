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
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class HandyboyPipes {
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafePipeHandle CreateNamedPipe(string name, uint mode, uint pipeMode, uint instances,
        uint outSize, uint inSize, uint timeout, ref SecurityAttributes security);
    static NamedPipeServerStream NewPipe(string name, PipeSecurity security, bool first) {
        byte[] descriptor = security.GetSecurityDescriptorBinaryForm();
        IntPtr memory = Marshal.AllocHGlobal(descriptor.Length);
        try {
            Marshal.Copy(descriptor, 0, memory, descriptor.Length);
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = memory };
            // .NET Framework rejects FirstPipeInstance in PipeOptions and cannot ask
            // to reject remote clients. Create every instance through Win32 with the
            // DACL at creation: OVERLAPPED|DUPLEX, FIRST_PIPE_INSTANCE on the first,
            // and PIPE_REJECT_REMOTE_CLIENTS (0x8) on all of them.
            uint mode = first ? 0x40080003u : 0x40000003u;
            var handle = CreateNamedPipe(@"\\.\pipe\" + name, mode, 0x8, 254, 4096, 4096, 0, ref attributes);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new System.ComponentModel.Win32Exception(error);
            }
            try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); }
            catch { handle.Dispose(); throw; }
        } finally { Marshal.FreeHGlobal(memory); }
    }
    sealed class Client {
        public NamedPipeServerStream Pipe;
        public Task Writes = Task.FromResult(0);
        public long Pending;
    }
    static ConcurrentDictionary<int, Client> clients = new ConcurrentDictionary<int, Client>();
    static object output = new object();
    static int sequence = 0;
    static void Emit(string line) { lock (output) { Console.Out.WriteLine(line); Console.Out.Flush(); } }
    static void Close(int id) {
        Client client;
        if (clients.TryRemove(id, out client)) { client.Pipe.Dispose(); Emit("close " + id); }
    }
    static async Task Write(int id, Client client, byte[] bytes) {
        try { await client.Pipe.WriteAsync(bytes, 0, bytes.Length); }
        catch (IOException) { Close(id); } catch (ObjectDisposedException) { Close(id); }
        finally { System.Threading.Interlocked.Add(ref client.Pending, -bytes.Length); }
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
            var pipe = NewPipe(name, security, !ready);
            if (!ready) { Emit("ready"); ready = true; }
            await pipe.WaitForConnectionAsync();
            int id = ++sequence;
            clients[id] = new Client { Pipe = pipe };
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
            Client client;
            if (!clients.TryGetValue(id, out client)) continue;
            // Preserve each client's reply order without letting a stalled reader
            // block other clients or the helper's stdin EOF/shutdown handling.
            if (parts[0] == "close") {
                client.Writes = client.Writes.ContinueWith(t => Close(id));
                continue;
            }
            if (parts[0] == "write" && parts.Length == 3) {
                var bytes = Convert.FromBase64String(parts[2]);
                if (System.Threading.Interlocked.Add(ref client.Pending, bytes.Length) > 8 * 1024 * 1024) {
                    Close(id); continue;
                }
                int clientId = id;
                Client target = client;
                client.Writes = client.Writes.ContinueWith(t => Write(clientId, target, bytes)).Unwrap();
            }
        }
        foreach (int id in clients.Keys) Close(id);
    }
}
'@ -WarningAction SilentlyContinue
[HandyboyPipes]::Run($PipeName)
