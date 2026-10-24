#!/usr/bin/python3
"""Top-bar indicator for the keyscreen server.

Click: open the dashboard (starting the server first if it's stopped).
Right-click: menu with Open dashboard / Start or Stop server.

Speaks the StatusNotifierItem + dbusmenu D-Bus protocols directly with GLib, so it needs only the
system Python. GNOME shows it through the "Ubuntu AppIndicators" extension.
"""
import json
import os
import subprocess
import urllib.request

from gi.repository import Gio, GLib

SERVER = os.environ.get("KEYSCREEN_SERVER", "http://localhost:4110")
ITEM_PATH = "/StatusNotifierItem"
MENU_PATH = "/MenuBar"
ICONS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")

ITEM_XML = """
<node><interface name="org.kde.StatusNotifierItem">
  <property name="Category" type="s" access="read"/>
  <property name="Id" type="s" access="read"/>
  <property name="Title" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="IconName" type="s" access="read"/>
  <property name="IconThemePath" type="s" access="read"/>
  <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
  <property name="ItemIsMenu" type="b" access="read"/>
  <property name="Menu" type="o" access="read"/>
  <method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
  <signal name="NewToolTip"/>
  <signal name="NewIcon"/>
</interface></node>"""

MENU_XML = """
<node><interface name="com.canonical.dbusmenu">
  <property name="Version" type="u" access="read"/>
  <property name="Status" type="s" access="read"/>
  <method name="GetLayout">
    <arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="as" direction="in"/>
    <arg type="u" direction="out"/><arg type="(ia{sv}av)" direction="out"/>
  </method>
  <method name="GetGroupProperties">
    <arg type="ai" direction="in"/><arg type="as" direction="in"/><arg type="a(ia{sv})" direction="out"/>
  </method>
  <method name="GetProperty">
    <arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/>
  </method>
  <method name="Event">
    <arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="in"/><arg type="u" direction="in"/>
  </method>
  <method name="AboutToShow"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
  <signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal>
</interface></node>"""

OPEN, TOGGLE = 1, 2


def server_status():
    try:
        with urllib.request.urlopen(f"{SERVER}/api/status", timeout=0.6) as r:
            return json.load(r)
    except Exception:
        return None


class Indicator:
    def __init__(self, bus: Gio.DBusConnection):
        self.bus = bus
        self.running = server_status() is not None
        self.revision = 1
        self.name = f"org.kde.StatusNotifierItem-{os.getpid()}-1"
        bus.register_object(ITEM_PATH, Gio.DBusNodeInfo.new_for_xml(ITEM_XML).interfaces[0], self.on_item_call, self.on_item_prop, None)
        bus.register_object(MENU_PATH, Gio.DBusNodeInfo.new_for_xml(MENU_XML).interfaces[0], self.on_menu_call, self.on_menu_prop, None)
        Gio.bus_own_name_on_connection(bus, self.name, Gio.BusNameOwnerFlags.NONE, None, None)
        # Register with the panel now, and again whenever it (re)appears (e.g. extension turned on later).
        Gio.bus_watch_name_on_connection(bus, "org.kde.StatusNotifierWatcher", Gio.BusNameWatcherFlags.NONE, self.register, None)
        GLib.timeout_add_seconds(3, self.refresh)

    def register(self, *_):
        self.bus.call(
            "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.kde.StatusNotifierWatcher",
            "RegisterStatusNotifierItem", GLib.Variant("(s)", (self.name,)), None, Gio.DBusCallFlags.NONE, -1, None, None,
        )

    # ---- state ----
    def refresh(self):
        running = server_status() is not None
        if running != self.running:
            self.running = running
            self.changed()
        return True

    def changed(self):
        self.revision += 1
        self.bus.emit_signal(None, MENU_PATH, "com.canonical.dbusmenu", "LayoutUpdated", GLib.Variant("(ui)", (self.revision, 0)))
        self.bus.emit_signal(None, ITEM_PATH, "org.kde.StatusNotifierItem", "NewToolTip", None)
        self.bus.emit_signal(None, ITEM_PATH, "org.kde.StatusNotifierItem", "NewIcon", None)

    def tooltip(self):
        return "Keyboard screen: running" if self.running else "Keyboard screen: stopped (click to start)"

    # ---- actions ----
    def open_dashboard(self):
        if self.running:
            Gio.AppInfo.launch_default_for_uri(SERVER, None)
            return
        self.start_server()
        tries = [0]

        def wait():
            tries[0] += 1
            if server_status() is not None:
                self.running = True
                self.changed()
                Gio.AppInfo.launch_default_for_uri(SERVER, None)
                return False
            return tries[0] < 40

        GLib.timeout_add(250, wait)

    def start_server(self):
        subprocess.Popen(["systemctl", "--user", "start", "keyscreen.service"])

    def stop_server(self):
        try:
            urllib.request.urlopen(urllib.request.Request(f"{SERVER}/api/shutdown", data=b"{}", method="POST"), timeout=2)
        except Exception:
            subprocess.Popen(["systemctl", "--user", "stop", "keyscreen.service"])
        GLib.timeout_add(1500, self.refresh)

    # ---- StatusNotifierItem ----
    def on_item_prop(self, _bus, _sender, _path, _iface, prop):
        values = {
            "Category": GLib.Variant("s", "Hardware"),
            "Id": GLib.Variant("s", "keyscreen"),
            "Title": GLib.Variant("s", "Keyboard screen"),
            "Status": GLib.Variant("s", "Active"),
            "IconName": GLib.Variant("s", "keyscreen-symbolic" if self.running else "keyscreen-off-symbolic"),
            "IconThemePath": GLib.Variant("s", ICONS),
            "ToolTip": GLib.Variant("(sa(iiay)ss)", ("", [], "Keyboard screen", self.tooltip())),
            "ItemIsMenu": GLib.Variant("b", False),
            "Menu": GLib.Variant("o", MENU_PATH),
        }
        return values.get(prop)

    def on_item_call(self, _bus, _sender, _path, _iface, method, _params, inv):
        if method == "Activate":
            self.open_dashboard()
        inv.return_value(None)

    # ---- dbusmenu ----
    def items(self):
        return [
            (OPEN, {"label": GLib.Variant("s", "Open dashboard")}),
            (TOGGLE, {"label": GLib.Variant("s", "Stop server" if self.running else "Start server")}),
        ]

    def on_menu_prop(self, _bus, _sender, _path, _iface, prop):
        return {"Version": GLib.Variant("u", 3), "Status": GLib.Variant("s", "normal")}.get(prop)

    def on_menu_call(self, _bus, _sender, _path, _iface, method, params, inv):
        if method == "GetLayout":
            children = [GLib.Variant("(ia{sv}av)", (i, props, [])) for i, props in self.items()]
            root = (0, {"children-display": GLib.Variant("s", "submenu")}, children)
            inv.return_value(GLib.Variant("(u(ia{sv}av))", (self.revision, root)))
        elif method == "GetGroupProperties":
            ids = params.unpack()[0]
            inv.return_value(GLib.Variant("(a(ia{sv}))", ([(i, p) for i, p in self.items() if not ids or i in ids],)))
        elif method == "GetProperty":
            item_id, name = params.unpack()
            props = dict(self.items()).get(item_id, {})
            inv.return_value(GLib.Variant("(v)", (props.get(name, GLib.Variant("s", "")),)))
        elif method == "Event":
            item_id, event = params.unpack()[:2]
            if event == "clicked":
                if item_id == OPEN:
                    self.open_dashboard()
                elif item_id == TOGGLE:
                    self.stop_server() if self.running else self.open_dashboard()
            inv.return_value(None)
        elif method == "AboutToShow":
            self.refresh()
            inv.return_value(GLib.Variant("(b)", (False,)))
        else:
            inv.return_value(None)


if __name__ == "__main__":
    Indicator(Gio.bus_get_sync(Gio.BusType.SESSION, None))
    GLib.MainLoop().run()
