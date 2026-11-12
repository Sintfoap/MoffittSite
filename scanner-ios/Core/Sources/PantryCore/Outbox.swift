import Foundation

/// What waits on the phone: additions made with no connection (a basement
/// pantry, a store with no signal), sent once there's one again, and lines
/// the site wouldn't take when they were sent later, to fix in the app.
/// Both are JSON files in `folder`, kept off backups.
public final class Outbox {
    let queueFile: URL, fixFile: URL
    private let lock = NSLock()

    public init(folder: URL) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        queueFile = folder.appendingPathComponent("queue.json")
        fixFile = folder.appendingPathComponent("to-fix.json")
    }

    private func read(_ f: URL) -> [JSON] {
        guard let d = try? Data(contentsOf: f) else { return [] }
        return (try? JSONSerialization.jsonObject(with: d)) as? [JSON] ?? []
    }
    private func write(_ f: URL, _ a: [JSON]) {
        if a.isEmpty { try? FileManager.default.removeItem(at: f); return }
        guard let d = try? JSONSerialization.data(withJSONObject: a) else { return }
        try? d.write(to: f, options: .atomic)
        #if os(iOS)
        var u = f; var v = URLResourceValues(); v.isExcludedFromBackup = true; try? u.setResourceValues(v)
        #endif
    }

    /// Batches to send: [{store, lines}], oldest first.
    public func queue() -> [JSON] { lock.lock(); defer { lock.unlock() }; return read(queueFile) }
    public func enqueue(store: String, lines: [JSON]) {
        lock.lock(); defer { lock.unlock() }
        write(queueFile, read(queueFile) + [["store": store, "lines": lines]])
    }
    /// Drops the oldest batch, once it's been sent (or kept to fix).
    public func dropFirst() {
        lock.lock(); defer { lock.unlock() }
        write(queueFile, Array(read(queueFile).dropFirst()))
    }

    public func toFix() -> [JSON] { lock.lock(); defer { lock.unlock() }; return read(fixFile) }
    public func addToFix(_ lines: [JSON]) {
        guard !lines.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        write(fixFile, read(fixFile) + lines)
    }
    public func clearToFix() { lock.lock(); defer { lock.unlock() }; write(fixFile, []) }

    /// The lines of a batch the site wouldn't take (its answer's `failed`), each with its store and error.
    public static func failedLines(batch: JSON, answer: JSON) -> [JSON] {
        let why = Dictionary(answer.list("failed").map { ($0.str("key"), $0.str("error")) }, uniquingKeysWith: { a, _ in a })
        guard !why.isEmpty else { return [] }
        let store = batch.str("store")
        return batch.list("lines").compactMap { l in
            guard let e = why[l.str("key")] else { return nil }
            var o = l; o["store"] = store; o["error"] = e; return o
        }
    }

    /// Sends what's waiting, oldest first, until it's all gone or there's no connection.
    /// → whether everything went. Throws Unpaired (the batches wait for a new pairing).
    @discardableResult
    public func send(with site: Site) async throws -> Bool {
        while let batch = queue().first {
            do {
                let out = try await site.add(store: batch.str("store"), lines: batch.list("lines"))
                addToFix(Outbox.failedLines(batch: batch, answer: out))
            } catch let e as Unpaired {
                throw e
            } catch {
                if isOffline(error) { return false }
                // The site said no to the whole batch (it shouldn't): keep its lines to fix rather than lose them.
                let store = batch.str("store")
                addToFix(batch.list("lines").map { var o = $0; o["store"] = store; o["error"] = error.localizedDescription; return o })
            }
            dropFirst()
        }
        return true
    }
}
