import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The site's answer was an error: its message, as the site said it.
public struct SiteError: Error, LocalizedError {
    public let message: String, status: Int
    public init(message: String, status: Int) { self.message = message; self.status = status }
    public var errorDescription: String? { message }
}

/// This phone's key was unpaired (or its owner lost Pantry): pair again.
public struct Unpaired: Error, LocalizedError {
    public let message: String
    public init(message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// No connection to the site (rather than the site saying no).
public func isOffline(_ e: Error) -> Bool {
    if e is SiteError || e is Unpaired { return false }
    return e is URLError || (e as NSError).domain == NSURLErrorDomain
}

/// The site's Pantry API (src/pantry.js, src/pantry_scanner.js), as this phone's pairing.
/// The same calls as the Android scanner's (scanner/.../Site.kt).
public struct Site {
    public let origin: String
    let key: String?
    let version: String
    let session: URLSession

    public init(origin: String, key: String?, version: String = "1", session: URLSession = .shared) {
        self.origin = origin; self.key = key; self.version = version; self.session = session
    }

    public func call(_ method: String, _ path: String, _ body: JSON? = nil, timeout: TimeInterval = 30) async throws -> JSON {
        guard let url = URL(string: origin + path) else { throw SiteError(message: "that isn't a site address", status: 0) }
        var r = URLRequest(url: url, timeoutInterval: timeout)
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        r.setValue("pantry-scanner-ios/\(version)", forHTTPHeaderField: "User-Agent")
        if let key { r.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: r)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? JSON ?? [:]
        if status == 401 && key != nil { throw Unpaired(message: json.str("error", "this phone isn't paired any more")) }
        if status >= 400 { throw SiteError(message: json.str("error", "the site answered \(status)"), status: status) }
        return json
    }

    public func items(day: String) async throws -> JSON { try await call("GET", "/pantry/api/items?day=\(day)") }
    public func barcode(_ code: String, day: String) async throws -> JSON { try await call("GET", "/pantry/api/barcode/\(code)?day=\(day)") }
    public func receipt(images: [String], day: String) async throws -> JSON {
        try await call("POST", "/pantry/api/receipt?day=\(day)", ["images": images.map { ["data": $0] }], timeout: 180)
    }
    public func add(store: String, lines: [JSON]) async throws -> JSON {
        try await call("POST", "/pantry/api/add", ["store": store, "lines": lines], timeout: 60)
    }

    /// A pairing code (from the QR code, or typed) for this phone's key: {key, site, name, username, display_name}.
    public static func pair(origin: String, code: String, name: String, version: String = "1") async throws -> JSON {
        try await Site(origin: origin, key: nil, version: version).call("POST", "/pantry/scanner/pair", ["code": code, "name": name])
    }

    /// What a pairing QR code says: (site, code), or nil if it isn't one.
    public static func readPairLink(_ text: String) -> (site: String, code: String)? {
        guard let u = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              u.scheme == "sintfoap-scanner", u.host == "pair" else { return nil }
        let q = Dictionary((u.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        guard let raw = q["site"], let site = cleanSite(raw),
              let code = q["code"], !code.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return (site, code)
    }

    /// "sintfoap.xyz" or "https://sintfoap.xyz/" → "https://sintfoap.xyz"; plain http only for a computer on this network (testing).
    public static func cleanSite(_ raw: String) -> String? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        if !s.contains("://") { s = "https://" + s }
        guard let u = URLComponents(string: s), let scheme = u.scheme?.lowercased(), let host = u.host?.lowercased(), !host.isEmpty else { return nil }
        let local = host == "localhost" || host.hasPrefix("192.168.") || host.hasPrefix("10.")
        guard scheme == "https" || (scheme == "http" && local) else { return nil }
        return "\(scheme)://\(host)" + (u.port.map { ":\($0)" } ?? "")
    }
}
