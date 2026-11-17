// Binary-transparent Windows executable entry point for Chrome Native Messaging.
// Configuration is generated alongside the executable by build_native_host.ps1.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class NativeHostLauncher
{
    private static int Main(string[] args)
    {
        Process child = null;
        try
        {
            string directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            var config = new JavaScriptSerializer().Deserialize<Dictionary<string, string>>(
                File.ReadAllText(Path.Combine(directory, "mca-native-host.json")));
            string python = config["python"];
            string root = config["project_root"];
            if (!Path.IsPathRooted(python) || !File.Exists(python) || !Path.IsPathRooted(root))
                throw new InvalidOperationException("Invalid absolute Python/project path in native host configuration.");
            // Chrome supplies its origin and --parent-window. Neither is a CLI argument.
            if (args.Length > 0 && args[0] != config["allowed_origin"])
                throw new InvalidOperationException("Unexpected extension origin.");
            var start = new ProcessStartInfo(python, "-u -m multi_chat_agent native-host");
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.EnvironmentVariables["PYTHONUNBUFFERED"] = "1";
            start.EnvironmentVariables["MCA_HOME"] = config["mca_home"];
            child = Process.Start(start);
            Process running = child;
            // BaseStream preserves bytes: no text decoding, BOM, newline conversion or logging.
            Task input = Task.Factory.StartNew(delegate {
                try { Console.OpenStandardInput().CopyTo(running.StandardInput.BaseStream); }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
                finally { try { running.StandardInput.Close(); } catch (IOException) { } }
            }, TaskCreationOptions.LongRunning);
            Task output = Task.Factory.StartNew(delegate {
                try {
                    Stream destination = Console.OpenStandardOutput();
                    running.StandardOutput.BaseStream.CopyTo(destination);
                    destination.Flush();
                } catch { try { running.Kill(); } catch { } throw; }
            }, TaskCreationOptions.LongRunning);
            Task error = Task.Factory.StartNew(delegate {
                running.StandardError.BaseStream.CopyTo(Console.OpenStandardError());
            }, TaskCreationOptions.LongRunning);
            child.WaitForExit();
            Task.WaitAll(output, error);
            // Do not wait for stdin: Chrome can keep it open after the child has exited.
            GC.KeepAlive(input);
            return child.ExitCode;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("MCA native launcher: " + error.Message);
            if (child != null) { try { if (!child.HasExited) child.Kill(); } catch { } }
            return 1;
        }
        finally { if (child != null) child.Dispose(); }
    }
}
