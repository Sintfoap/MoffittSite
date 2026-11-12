import Foundation
import Security
import PantryCore

/// The pairing: which site, as whom, and this phone's key (in the Keychain,
/// this device only, never in a backup). Additions waiting for a connection
/// are in the Outbox, next to it.
final class Pairing {
    private let defaults = UserDefaults.standard
    private let service = "xyz.sintfoap.scanner.key"
    let outbox: Outbox

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        outbox = Outbox(folder: support.appendingPathComponent("pantry", isDirectory: true))
    }

    var site: String? { defaults.string(forKey: "site") }
    var who: String { defaults.string(forKey: "who") ?? "" }
    var key: String? { readKey() }
    var paired: Bool { site != nil && key != nil }

    func api() throws -> Site {
        guard let site, let key else { throw Unpaired(message: "not paired") }
        return Site(origin: site, key: key, version: appVersion)
    }

    func pair(site: String, key: String, who: String) {
        defaults.set(site, forKey: "site")
        defaults.set(who, forKey: "who")
        saveKey(key)
    }

    func unpair() {
        defaults.removeObject(forKey: "who")
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service] as CFDictionary)
    }

    private func saveKey(_ key: String) {
        let q: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: "key"]
        SecItemDelete(q as CFDictionary)
        var add = q
        add[kSecValueData] = Data(key.utf8)
        add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    private func readKey() -> String? {
        let q: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: "key",
                                  kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
}

let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
let defaultSite = Bundle.main.object(forInfoDictionaryKey: "PantryDefaultSite") as? String ?? "https://sintfoap.xyz"
