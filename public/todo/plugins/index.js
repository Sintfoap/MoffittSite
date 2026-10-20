// Drift's plugins. An item is plain base data (title, notes, tags, collection);
// each plugin owns one slice of item.meta, named by its id, and may bring a
// view that shows a collection's items its own way. Collections choose which
// plugins are on.
//
// A plugin is an object with:
//   id, name, description   id is the key under item.meta (lowercase letters)
//   icon                    SVG path markup for a 24×24 icon
//   clean(value, fail)      validates and normalises its meta; call fail(msg) to refuse.
//                           Runs in the browser and in the Worker, so no DOM here.
//   fresh(quick, ctx)       optional: meta for a new item added while the plugin is on
//                           (quick = parsed quick-add fields), or undefined for none
//   lead(item, ctx)         optional: a control drawn at the start of an item's row
//   rowClass(item, ctx)     optional: extra classes for an item's row
//   chips(item, ctx)        optional: HTML snippets shown under an item's title
//   editor(item, ctx)       HTML inputs for the item dialog; read(fields, item) turns
//                           those inputs back into meta (null removes it)
//   actions                 optional: { name(item, ctx, el) } for data-act="<id>:<name>"
//   keys                    optional: { key(item, ctx) } for the selected item
//   view                    optional: a whole view of the items, either
//                             { label, render(ctx) }  HTML, redrawn on every change, or
//                             { label, mount(el, ctx), update(ctx), unmount() }  for views
//                             that keep their own DOM between changes (graphs, canvases)
//
// To add a plugin, write a file like the ones below and add it to PLUGINS.
// New plugins start switched off in existing collections.

import checklist from "./checklist.js";
import events from "./events.js";
import list from "./list.js";
import graph from "./graph.js";
import location from "./location.js";

export const PLUGINS = [checklist, events, list, graph, location];
export const BY_ID = Object.fromEntries(PLUGINS.map(p => [p.id, p]));
