import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { KubePopupMenuItem } from './kubePopupMenuItem.js';
import { Kubectl } from './kubectl.js';
import { discover, expandHome } from './kubeconfigDiscovery.js';
import { throttle } from './utils.js';


export const KubeIndicator = GObject.registerClass({ GTypeName: 'KubeIndicator' },
    class KubeIndicator extends PanelMenu.Button {
        _init(extensionObject) {
            super._init(null, "Kube");
            this._extensionObject = extensionObject
            this._extensionUuid = extensionObject.metadata.uuid;
            this._settings = this._extensionObject.getSettings();

            this._monitors = [];

            // A throttled handler is needed because some editors save multiple
            // times per write, e.g. Sublime Text, and this broke the interface.
            this._throttledRefresh = throttle(this._update.bind(this), 500);

            this._buildMenu();

            this._setView();

            this._setupFileMonitors();

            this._bindSettingsChanges();
        }

        /**
         * The directory scanned for kubeconfig files. Empty setting means ~/.kube.
         *
         * @returns {String}
         */
        _kubeconfigDir() {
            const dir = this._settings.get_string('kubeconfig-dir');
            if (dir && dir.trim().length > 0) {
                return expandHome(dir.trim());
            }
            return GLib.get_home_dir() + '/.kube';
        }

        /**
         * Extra kubeconfig files or directories configured by the user.
         *
         * @returns {String[]}
         */
        _extraPaths() {
            return this._settings.get_strv('extra-kubeconfig-paths');
        }

        /**
         * Watch the kubeconfig directory and any extra paths so the menu
         * refreshes when files are added, removed or edited externally.
         */
        _setupFileMonitors() {
            for (const monitor of this._monitors) {
                monitor.cancel();
            }
            this._monitors = [];

            const watched = [this._kubeconfigDir(), ...this._extraPaths()
                .map(p => expandHome(p.trim()))
                .filter(p => p.length > 0)];

            for (const path of watched) {
                const file = Gio.File.new_for_path(path);
                let monitor;
                try {
                    // monitor_directory also reports edits to children, so a
                    // single watch per directory covers all its files.
                    monitor = file.monitor(Gio.FileMonitorFlags.WATCH_MOVES, null);
                } catch (_e) {
                    continue;
                }
                this._monitors.push(monitor);
                monitor.connect('changed', () => this._throttledRefresh());
            }
        }

        _buildMenu() {
            // contexts list section menu
            this.contextsMenuSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this.contextsMenuSection);

            // add seperator to popup menu
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // add actions section menu
            const actionsSection = new PopupMenu.PopupMenuSection();
            const actionsBox = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: 'popup-menu-ornament' });
            actionsSection.actor.add_child(actionsBox);
            this.menu.addMenuItem(actionsSection);

            // a space
            actionsBox.add_child(new St.BoxLayout({ x_expand: true }));

            // actions: add link to settings dialog
            const settingsMenuItem = new PopupMenu.PopupMenuItem('');
            settingsMenuItem.add_child(
                new St.Icon({
                    icon_name: 'emblem-system-symbolic',
                    style_class: 'popup-menu-icon',
                })
            );
            settingsMenuItem.connect("activate", (_item, _event) =>
                this._extensionObject.openPreferences()
            );
            actionsBox.add_child(settingsMenuItem);
        }

        async _update() {
            this.contextsMenuSection.removeAll();
            try {
                const discovered = await discover(this._kubeconfigDir(), this._extraPaths());
                const files = discovered.map(d => d.file);

                // Put a dedicated "holder" file first in the merge. kubectl writes
                // current-context to the first file, so switching contexts lands in
                // the holder and never pollutes the user's real kubeconfig files.
                const holder = files.length > 0 ? this._ensureHolder() : null;
                const merged = files.length > 0
                    ? [holder, ...files].filter(p => p && p.length > 0).join(':')
                    : "";

                this._syncPersistentKubeconfig(merged);

                // The current context is resolved against the merged view, the
                // same way the user's terminal will once KUBECONFIG is set.
                const currentContext = merged
                    ? await Kubectl.getCurrentContext(merged, true)
                    : "";

                if (this._settings.get_boolean('show-current-context') === true && this.label) {
                    this.label.text = currentContext || _("kubectl");
                }

                if (discovered.length === 0) {
                    const empty = new PopupMenu.PopupMenuItem(_("No kubeconfig files found"));
                    empty.setSensitive(false);
                    this.contextsMenuSection.addMenuItem(empty);
                    return;
                }

                // Only label groups when more than one file contributes contexts.
                const showHeaders = discovered.length > 1;
                for (const { file, contexts } of discovered) {
                    if (showHeaders) {
                        this.contextsMenuSection.addMenuItem(
                            new PopupMenu.PopupSeparatorMenuItem(GLib.path_get_basename(file)));
                    }
                    for (const context of contexts) {
                        const item = new KubePopupMenuItem(
                            this._extensionObject, context, file, merged, context === currentContext);
                        this.contextsMenuSection.addMenuItem(item);
                    }
                }
            } catch (e) {
                console.error(`${this._extensionObject.metadata.uuid}: ${e}`);
            }
        }

        /**
         * Ensure the current-context holder file exists. It is a minimal
         * kubeconfig carrying only `current-context`; placed first in the merge
         * it absorbs every `use-context` write, keeping real files pristine.
         *
         * @returns {String|null} the holder path, or null if it could not be created
         */
        _ensureHolder() {
            const dir = GLib.get_user_config_dir() + '/kube-config-extension';
            const path = dir + '/current-context.yaml';
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
                return path;
            }
            try {
                GLib.mkdir_with_parents(dir, 0o700);
                GLib.file_set_contents(path, 'apiVersion: v1\nkind: Config\ncurrent-context: ""\n');
                return path;
            } catch (e) {
                console.error(`${this._extensionObject.metadata.uuid}: cannot create holder ${path}: ${e}`);
                return null;
            }
        }

        /**
         * Persist the merged KUBECONFIG to ~/.config/environment.d so the
         * user's terminals resolve the same files and current context. This
         * only takes effect for sessions started after the next login.
         *
         * @param {String} merged - colon-separated KUBECONFIG value
         */
        _syncPersistentKubeconfig(merged) {
            if (!this._settings.get_boolean('sync-kubeconfig-env')) {
                return;
            }

            const dir = GLib.get_user_config_dir() + '/environment.d';
            const path = dir + '/10-kube-config-extension.conf';
            const content =
                `# Managed by the Kube Config GNOME extension. Do not edit.\n` +
                `KUBECONFIG=${merged}\n`;

            // Skip needless rewrites (the menu refreshes often).
            if (this._lastEnvContent === content) {
                return;
            }

            try {
                if (merged.length === 0) {
                    GLib.unlink(path);
                } else {
                    GLib.mkdir_with_parents(dir, 0o700);
                    GLib.file_set_contents(path, content);
                }
                this._lastEnvContent = content;
            } catch (e) {
                console.error(`${this._extensionObject.metadata.uuid}: cannot write ${path}: ${e}`);
            }
        }

        _setView() {
            this.remove_all_children();
            if (this._settings.get_boolean('show-current-context') === false) {
                let gicon = Gio.icon_new_for_string(this._extensionObject.path + '/icons/logo.svg');
                this.icon = new St.Icon({ gicon: gicon, style_class: 'system-status-icon' });
                this.add_child(this.icon);
            } else {
                this.label = new St.Label({
                    text: _("kubectl"),
                    y_align: Clutter.ActorAlign.CENTER
                });
                this.add_child(this.label);
            }
            this._update();
        }

        _bindSettingsChanges() {
            this._settings.connect('changed::show-current-context', () => {
                this._setView();
            });

            // Re-scan and re-watch when the source locations change.
            const onSourcesChanged = () => {
                this._setupFileMonitors();
                this._update();
            };
            this._settings.connect('changed::kubeconfig-dir', onSourcesChanged);
            this._settings.connect('changed::extra-kubeconfig-paths', onSourcesChanged);
        }

        destroy() {
            super.destroy();
            for (const monitor of this._monitors) {
                monitor.cancel();
                monitor.unref();
            }
            this._monitors = [];
        }
    });
