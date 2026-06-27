import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { Kubectl } from './kubectl.js';

// File name patterns that look like editor/manual backups; skipped during a
// directory scan so the same context doesn't show up twice.
const BACKUP_PATTERNS = [
    /\.bak/i,
    /\.backup/i,
    /-bac$/i,
    /~$/,
    /\.swp$/i,
    /\.save$/i,
    /\.orig$/i,
    /\.tmp$/i,
];

/**
 * @param {String} name - a file basename
 * @returns {boolean}
 */
function isBackupName(name) {
    return BACKUP_PATTERNS.some(re => re.test(name));
}

/**
 * Expand a leading `~` to the user's home directory.
 *
 * @param {String} path
 * @returns {String}
 */
export function expandHome(path) {
    if (path === '~' || path.startsWith('~/')) {
        return GLib.get_home_dir() + path.slice(1);
    }
    return path;
}

/**
 * List the regular files (non-recursive) directly inside a directory.
 *
 * @param {String} dirPath
 * @returns {String[]} absolute paths
 */
function listRegularFiles(dirPath) {
    const files = [];
    const dir = Gio.File.new_for_path(dirPath);

    let enumerator;
    try {
        enumerator = dir.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
    } catch (_e) {
        // Directory missing or unreadable; nothing to scan.
        return files;
    }

    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        if (info.get_file_type() === Gio.FileType.REGULAR) {
            files.push(dir.get_child(info.get_name()).get_path());
        }
    }
    enumerator.close(null);

    return files;
}

/**
 * Collect candidate kubeconfig file paths from the main directory plus any
 * extra files/directories. Backups are skipped, but explicitly listed extra
 * *files* are always included (the user asked for them by name).
 *
 * @param {String} dirPath - main directory to scan
 * @param {String[]} extraPaths - extra files or directories
 * @returns {String[]} deduped absolute paths
 */
export function collectCandidateFiles(dirPath, extraPaths) {
    const set = new Set();

    for (const f of listRegularFiles(dirPath)) {
        if (!isBackupName(GLib.path_get_basename(f))) {
            set.add(f);
        }
    }

    for (const raw of extraPaths) {
        const path = expandHome(raw.trim());
        if (path.length === 0) {
            continue;
        }
        const file = Gio.File.new_for_path(path);
        const type = file.query_file_type(Gio.FileQueryInfoFlags.NONE, null);
        if (type === Gio.FileType.DIRECTORY) {
            for (const f of listRegularFiles(path)) {
                if (!isBackupName(GLib.path_get_basename(f))) {
                    set.add(f);
                }
            }
        } else if (type === Gio.FileType.REGULAR) {
            set.add(file.get_path());
        }
        // Non-existent paths are silently ignored.
    }

    return [...set];
}

/**
 * Discover kubeconfig files and the contexts each one holds. A candidate is
 * kept only if kubectl can read at least one context from it, which naturally
 * filters out non-kubeconfig YAML and empty backups.
 *
 * @param {String} dirPath - main directory to scan
 * @param {String[]} extraPaths - extra files or directories
 * @returns {Promise<Array<{file: String, contexts: String[]}>>} sorted by file path
 */
export async function discover(dirPath, extraPaths) {
    const candidates = collectCandidateFiles(dirPath, extraPaths);

    const probed = await Promise.all(
        candidates.map(async file => ({
            file,
            contexts: await Kubectl.getContexts(file, true),
        }))
    );

    return probed
        .filter(entry => entry.contexts.length > 0)
        .sort((a, b) => a.file.localeCompare(b.file));
}
