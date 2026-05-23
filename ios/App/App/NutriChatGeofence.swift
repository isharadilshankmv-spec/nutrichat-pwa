import Foundation
import CoreLocation
import UserNotifications

// Watches the user's saved favourite restaurants (geofences) and, on arrival,
// fetches a macro-aware suggestion from the backend and posts a local notification.
// Saved spots come from Capacitor Preferences key "CapacitorStorage.fav_restaurants".
class NutriChatGeofence: NSObject, CLLocationManagerDelegate {
    static let shared = NutriChatGeofence()
    private let manager = CLLocationManager()

    func start() {
        manager.delegate = self
        manager.allowsBackgroundLocationUpdates = false
        refresh()
    }

    // Re-read saved restaurants and (re)monitor them. Called at launch and when the
    // app becomes active, so newly-saved spots start being watched.
    func refresh() {
        guard let json = UserDefaults.standard.string(forKey: "CapacitorStorage.fav_restaurants"),
              let data = json.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              !arr.isEmpty else {
            for r in manager.monitoredRegions { manager.stopMonitoring(for: r) }
            return
        }

        // Only ask for the (sensitive) Always permission once the user actually saves a spot.
        manager.requestAlwaysAuthorization()
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }

        for r in manager.monitoredRegions { manager.stopMonitoring(for: r) }
        for item in arr.prefix(20) {
            guard let name = item["name"] as? String,
                  let lat = item["lat"] as? Double,
                  let lng = item["lng"] as? Double else { continue }
            let region = CLCircularRegion(
                center: CLLocationCoordinate2D(latitude: lat, longitude: lng),
                radius: 120, identifier: name)
            region.notifyOnEntry = true
            region.notifyOnExit = false
            manager.startMonitoring(for: region)
        }
    }

    func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        Task { await notify(restaurant: region.identifier) }
    }

    private func notify(restaurant: String) async {
        var title = "🍴 \(restaurant)"
        var body = "You're at \(restaurant). Open NutriChat to see what fits your macros."

        if let key = UserDefaults.standard.string(forKey: "CapacitorStorage.siri_key"), !key.isEmpty {
            do {
                var req = URLRequest(url: URL(string: "https://nutrichat-pwa.vercel.app/api/restaurant-suggest")!)
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = try JSONSerialization.data(withJSONObject: ["key": key, "restaurant": restaurant])
                let (data, _) = try await URLSession.shared.data(for: req)
                if let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if let t = obj["title"] as? String, !t.isEmpty { title = t }
                    if let b = obj["body"] as? String, !b.isEmpty { body = b }
                }
            } catch {}
        }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}
