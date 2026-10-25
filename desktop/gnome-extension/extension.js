// keyscreen pointer: shares the mouse pointer position over D-Bus, for keyscreen's Sand mode.
//
//   org.keyscreen.Pointer /org/keyscreen/Pointer
//     Watch()                     keep sending positions for the next 5 s (call every few seconds)
//     Get() -> (x, y, w, h)       pointer position and desktop size, in pixels
//     signal Moved(x, y, w, h)    sent ~30 times a second while watched, when the pointer moves
//
// While nobody is watching it does nothing but a cheap timer check.
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const XML = `
<node>
  <interface name="org.keyscreen.Pointer">
    <method name="Watch"/>
    <method name="Get">
      <arg type="i" direction="out"/><arg type="i" direction="out"/>
      <arg type="i" direction="out"/><arg type="i" direction="out"/>
    </method>
    <signal name="Moved">
      <arg type="i"/><arg type="i"/><arg type="i"/><arg type="i"/>
    </signal>
  </interface>
</node>`;

export default class KeyscreenPointer extends Extension {
  enable() {
    this._watchUntil = 0;
    this._last = "";
    this._impl = Gio.DBusExportedObject.wrapJSObject(XML, {
      Watch: () => {
        this._watchUntil = GLib.get_monotonic_time() + 5_000_000;
      },
      Get: () => this._state(),
    });
    this._impl.export(Gio.DBus.session, "/org/keyscreen/Pointer");
    this._name = Gio.bus_own_name(
      Gio.BusType.SESSION,
      "org.keyscreen.Pointer",
      Gio.BusNameOwnerFlags.NONE,
      null,
      null,
      null,
    );
    this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
      if (GLib.get_monotonic_time() < this._watchUntil) {
        const s = this._state();
        const key = s.join(",");
        if (key !== this._last) {
          this._last = key;
          this._impl.emit_signal("Moved", new GLib.Variant("(iiii)", s));
        }
      }
      return GLib.SOURCE_CONTINUE;
    });
  }

  disable() {
    if (this._timer) GLib.source_remove(this._timer);
    this._timer = 0;
    this._impl?.unexport();
    this._impl = null;
    if (this._name) Gio.bus_unown_name(this._name);
    this._name = 0;
  }

  _state() {
    const [x, y] = global.get_pointer();
    return [x, y, global.stage.width, global.stage.height];
  }
}
