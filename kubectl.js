import GLib from 'gi://GLib';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { execCommunicateAsync } from './commandLineUtil.js';

class BaseKubectl {
    static _kubectlExes = ['kubectl', 'oc'];
    static _kubectlExe = null;

    /**
     *
     * @param {Extension} extension
     */
    static init(uuid) {
        this._extensionUUID = uuid;

        // ensure one executable is installed
        for (const exe of this._kubectlExes) {
            if (GLib.find_program_in_path(exe) !== null) {
                this._kubectlExe = exe;
                return;
            }
        }

        // alert user on missing executable
        Main.notifyError(this._extensionUUID, _(`${this._kubectlExes.join(_(' or '))} not in PATH`));
    }
}

export class Kubectl extends BaseKubectl {

    /**
     * Build the env overlay that points kubectl at the given kubeconfig file(s).
     *
     * @param {String|null|undefined} kubeconfig - colon-separated KUBECONFIG value
     * @returns {Object|null}
     */
    static _env(kubeconfig) {
        if (kubeconfig === null || kubeconfig === undefined || kubeconfig === "") {
            return null;
        }
        return { KUBECONFIG: kubeconfig };
    }

    /**
     * Get kubectl version.
     *
     * @param {String|undefined} context
     * @param {String|undefined} kubeconfig - KUBECONFIG to target
     * @returns {Promise<String>}
     */
    static async version(context, kubeconfig) {
        if (this._kubectlExe === null) {
            return "";
        }

        let argv = [this._kubectlExe, `--request-timeout=3`];
        if (!(context === null || context === undefined)) {
            argv.push(`--context=${context}`);
        }
        argv.push(`version`);

        try {
            const output = await execCommunicateAsync(argv, null, null, this._env(kubeconfig));
            return output;
        } catch (_e) {
            //console.error(`${Kubectl._extensionUUID} cannot retrieve kubeconfig contexts: ${_e}`);
            return "";
        }
    }

    /**
     * Check if `context` is reachable.
     * If `context` not specified, check for current context.
     * The kubectl version is the lightweight method to check reachability.
     *
     * @param {String|undefined} context
     * @param {String|undefined} kubeconfig - KUBECONFIG to target
     * @returns {Promise<String>}
     */
    static async clusterIsReachable(context, kubeconfig) {
        if (this._kubectlExe === null) {
            return false;
        }
        const v = await Kubectl.version(context, kubeconfig);
        return v !== "";
    }

    /**
     * Get kubeconfg contexts
     *
     * @param {String|undefined} kubeconfig - KUBECONFIG to target
     * @param {boolean} [quiet] - suppress error notifications (used while probing files)
     * @returns {Promise<String[]>}
     */
    static async getContexts(kubeconfig, quiet = false) {
        if (this._kubectlExe === null) {
            return [];
        }

        const argv = [this._kubectlExe, 'config', 'get-contexts', '-oname'];
        try {
            const output = await execCommunicateAsync(argv, null, null, this._env(kubeconfig));
            return output.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        } catch (e) {
            if (!quiet) {
                Main.notifyError(this._extensionUUID, _(`cannot retrieve kubeconfig contexts: ${e}`));
            }
            return [];
        }
    }

    /**
     * Get kubeconfg current-context
     *
     * @param {String|undefined} kubeconfig - KUBECONFIG to target
     * @param {boolean} [quiet] - suppress error notifications (no current-context is normal)
     * @returns {Promise<string>}
     */
    static async getCurrentContext(kubeconfig, quiet = false) {
        if (this._kubectlExe === null) {
            return "";
        }

        const argv = [this._kubectlExe, 'config', 'current-context'];
        try {
            return await execCommunicateAsync(argv, null, null, this._env(kubeconfig));
        } catch (e) {
            if (!quiet) {
                Main.notifyError(this._extensionUUID, _(`cannot retrieve current kubeconfig contexts: ${e}`));
            }
            return "";
        }
    }

    /**
     * Set kubeconfg use-context
     *
     * @param {String} context
     * @param {String|undefined} kubeconfig - KUBECONFIG to target
     * @returns {Promise<boolean>}
     */
    static async useContext(context, kubeconfig) {
        if (this._kubectlExe === null) {
            return false;
        }

        const argv = [this._kubectlExe, 'config', 'use-context', `${context}`];
        try {
            await execCommunicateAsync(argv, null, null, this._env(kubeconfig));
            return true;
        } catch (e) {
            Main.notifyError(this._extensionUUID, _(`cannot set kubeconfig context '${context}': ${e}`));
            return false;
        }
    }
}
