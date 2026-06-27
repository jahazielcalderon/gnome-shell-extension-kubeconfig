import Gio from 'gi://Gio';

/**
 * From https://gjs.guide/guides/gio/subprocesses.html
 */

/* Gio.Subprocess */
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

/**
 * Execute a command asynchronously and return the output from `stdout` on
 * success or throw an error with output from `stderr` on failure.
 *
 * If given, @input will be passed to `stdin` and @cancellable can be used to
 * stop the process before it finishes.
 *
 * If given, @env is a plain object of environment variables to overlay on top of
 * the inherited environment (e.g. `{ KUBECONFIG: '/path/a:/path/b' }`).
 *
 * @param {string[]} argv - a list of string arguments
 * @param {string} [input] - Input to write to `stdin` or %null to ignore
 * @param {Gio.Cancellable} [cancellable] - optional cancellable object
 * @param {Object|null} [env] - environment variables to override, or %null to inherit as-is
 * @returns {Promise<string>} - The process output
 */
export async function execCommunicateAsync(argv, input = null, cancellable = null, env = null) {
    let cancelId = 0;
    let flags = Gio.SubprocessFlags.STDOUT_PIPE |
        Gio.SubprocessFlags.STDERR_PIPE;

    if (input !== null)
        flags |= Gio.SubprocessFlags.STDIN_PIPE;

    let proc;
    if (env !== null) {
        // Use a launcher so we can overlay env vars (e.g. KUBECONFIG) while
        // inheriting the rest of gnome-shell's environment.
        const launcher = new Gio.SubprocessLauncher({ flags });
        for (const [key, value] of Object.entries(env)) {
            launcher.setenv(key, value, true);
        }
        proc = launcher.spawnv(argv);
    } else {
        proc = new Gio.Subprocess({ argv, flags });
        proc.init(cancellable);
    }

    if (cancellable instanceof Gio.Cancellable)
        cancelId = cancellable.connect(() => proc.force_exit());

    try {
        const [stdout, stderr] = await proc.communicate_utf8_async(input, null);

        const status = proc.get_exit_status();

        if (status !== 0) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.FAILED,
                message: stderr ? stderr.trim() : `Command '${argv}' failed with exit code ${status}`,
            });
        }
        return stdout.trim();
    } finally {
        if (cancelId > 0)
            cancellable.disconnect(cancelId);
    }
}
