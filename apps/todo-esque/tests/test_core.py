import random, shutil, tempfile, time
from pathlib import Path
from drift.core import Store, parse_quick, parse_date
from datetime import date

def test_convergence():
    root = Path(tempfile.mkdtemp())
    a_v, b_v = root/"a", root/"b"
    A, B = Store(a_v, "alpha"), Store(b_v, "beta")
    t = A.add("shared task", priority=1)
    # "sync" A -> B
    shutil.copy(A.my_log, b_v/"log"/A.my_log.name); B.refresh()
    assert B.get(t.id).title == "shared task"
    # concurrent conflicting edits while offline
    A.update(t.id, title="from alpha"); time.sleep(0.002)
    B.update(t.id, title="from beta", priority=3)
    A.update(t.id, done=True)
    # sync both ways
    shutil.copy(A.my_log, b_v/"log"/A.my_log.name)
    shutil.copy(B.my_log, a_v/"log"/B.my_log.name)
    A.refresh(); B.refresh()
    ta, tb = A.get(t.id), B.get(t.id)
    assert ta == tb, (ta, tb)
    assert ta.title == "from beta" and ta.priority == 3 and ta.done
    print("converged:", ta.title, ta.priority, ta.done)

def test_order_independence():
    root = Path(tempfile.mkdtemp())
    nodes = [Store(root/f"n{i}", f"n{i}") for i in range(3)]
    t = nodes[0].add("x")
    for s in nodes[1:]:
        shutil.copy(nodes[0].my_log, s.logdir/nodes[0].my_log.name); s.refresh()
    for _ in range(60):
        s = random.choice(nodes)
        s.update(t.id, title=f"v{random.randint(0,999)}", priority=random.randint(0,3))
    # gather every log into fresh stores in different orders
    results = []
    for perm in range(4):
        d = root/f"merge{perm}"; (d/"log").mkdir(parents=True)
        order = nodes[:]; random.shuffle(order)
        for s in order: shutil.copy(s.my_log, d/"log"/s.my_log.name)
        results.append(Store(d, f"m{perm}").get(t.id).__dict__ | {"updated": None})
    assert all(r == results[0] for r in results); print("order-independent ✓")

def test_quick():
    title, f = parse_quick("Call mom #family +home !2 ^tomorrow")
    assert title == "Call mom" and f["tags"] == ["family"] and f["project"] == "home" and f["priority"] == 2
    assert f["due"] == parse_date("tom")
    assert parse_quick("ship it !!!")[1]["priority"] == 3
    assert parse_date("fri") > date.today().isoformat()
    print("quick-add ✓", f)

test_convergence(); test_order_independence(); test_quick()
