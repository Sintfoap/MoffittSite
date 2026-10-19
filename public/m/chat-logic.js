// Chat's rules for the phone app: how the room list is split up and how a
// room's messages are grouped. No DOM here, so the tests can run it.

// Messages this close together from one person share a heading, as on the web page.
export const GROUP_SECONDS = 5 * 60;

// The room list: rooms you're in, direct messages, rooms from your
// connections (Matrix, …), and open rooms you could join. Unread first in each.
export function roomSections(rooms) {
  const hot = (a, b) => (b.mentions - a.mentions) || (b.unread - a.unread) || (b.last_at - a.last_at);
  const pick = f => rooms.filter(f).sort(hot);
  return [
    { id: "rooms", title: "Rooms", rooms: pick(r => r.joined && (r.kind === "open" || r.kind === "private")) },
    { id: "dms", title: "Direct messages", rooms: pick(r => r.kind === "dm") },
    { id: "bridge", title: "Connections", rooms: pick(r => r.kind === "bridge") },
    { id: "browse", title: "Open rooms to join", rooms: pick(r => !r.joined && r.kind === "open") },
  ].filter(s => s.rooms.length);
}

export const unreadTotal = rooms => rooms.reduce((n, r) => n + (r.joined ? r.unread || 0 : 0), 0);

// A room's messages as rows to draw: a day line when the day changes, and
// whether each message starts a new group (another person, or a long gap).
export function messageRows(messages, dayLabel) {
  const out = [];
  let prev = null, lastDay = null;
  for (const m of [...messages].filter(m => !m.deleted).sort((a, b) => a.id - b.id)) {
    const d = dayLabel(m.created_at);
    if (d !== lastDay) { out.push({ day: d }); lastDay = d; prev = null; }
    out.push({ m, first: !prev || prev.author !== m.author || m.created_at - prev.created_at > GROUP_SECONDS });
    prev = m;
  }
  return out;
}

// Folds a poll's changes (new, edited, deleted messages) into the ones held.
export function mergeMessages(held, changes) {
  const byId = new Map(held.map(m => [m.id, m]));
  for (const m of changes) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

// "Sam is typing…", "Sam and Kim are typing…", "3 people are typing…"
export function typingLine(names) {
  if (!names?.length) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.length} people are typing…`;
}

// What a room is called in the list, with its marker: # open, * private, @ person, ~ elsewhere.
export const MARK = { open: "#", private: "*", dm: "@", bridge: "~" };
