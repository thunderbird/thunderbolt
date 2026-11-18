# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Offers a file the way a Linux file manager does, for linux.ts. Prints "ready", then runs until killed.

drag PATH: a 120-pixel window at the screen's top-left corner whose button drags PATH as text/uri-list.
copy PATH: owns the clipboard with PATH copied, in the formats a file manager copy puts there.
drag-link URL, copy-link URL: the same with a link, offered as text/uri-list and bare text/plain, which GTK
cannot read as text.
"""

import sys

import gi

gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

mode, path = sys.argv[1:]
link = mode.endswith("-link")
uri = path if link else GLib.filename_to_uri(path)

if mode.startswith("drag"):
    window = Gtk.Window(title="file-source")
    button = Gtk.Button(label="drag")
    targets = [Gtk.TargetEntry.new("text/uri-list", 0, 0)] + ([Gtk.TargetEntry.new("text/plain", 0, 1)] if link else [])
    button.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, targets, Gdk.DragAction.COPY)
    button.connect(
        "drag-data-get",
        lambda _button, _context, data, info, _time: data.set_uris([uri]) if info == 0 else data.set_text(uri, -1),
    )
    window.add(button)
    window.set_default_size(120, 120)
    window.move(0, 0)
    window.connect("map-event", lambda *_: print("ready", flush=True))
    window.show_all()
else:
    offers = {"text/uri-list": f"{uri}\r\n"} | (
        {"text/plain": uri} if link else {"x-special/gnome-copied-files": f"copy\n{uri}"}
    )
    owner = Gtk.Invisible()
    owner.connect(
        "selection-get",
        lambda _owner, data, _info, _time: data.set(data.get_target(), 8, offers[data.get_target().name()].encode()),
    )
    Gtk.selection_owner_set(owner, Gdk.SELECTION_CLIPBOARD, Gdk.CURRENT_TIME)
    for target in offers:
        Gtk.selection_add_target(owner, Gdk.SELECTION_CLIPBOARD, Gdk.Atom.intern(target, False), 0)
    print("ready", flush=True)

Gtk.main()
