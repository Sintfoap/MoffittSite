import sys
from datetime import date, timedelta
from drift.core import Store
s = Store(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "laptop-3fa9c1")
d = lambda n: (date.today() + timedelta(days=n)).isoformat()
for title, kw in [
  ("Renew passport", dict(due=d(-2), priority=3, tags=["admin"])),
  ("Review Mira's PR on the sync engine", dict(due=d(0), priority=2, project="work", tags=["code"])),
  ("Water the fiddle-leaf fig", dict(due=d(0), project="home")),
  ("Book dentist cleaning", dict(due=d(0), priority=1, tags=["health"])),
  ("Draft Q4 planning doc", dict(due=d(2), priority=2, project="work", notes="Pull numbers from the October dashboard.")),
  ("Pick up film from the lab", dict(due=d(3), project="errands")),
  ("Call mom about Thanksgiving flights", dict(due=d(5), tags=["family"])),
  ("Try the new ramen place on 4th", dict(tags=["fun"])),
  ("Read 'The Dispossessed'", dict(tags=["books"])),
  ("Replace bike chain", dict(project="home", priority=1)),
]:
    s.add(title, **kw)
t = s.add("Pay October rent", project="home", due=d(-1)); s.toggle(t.id)
t = s.add("Ship v0.3 of drift", project="work", priority=3); s.toggle(t.id)
print("seeded", len(s.tasks()))
