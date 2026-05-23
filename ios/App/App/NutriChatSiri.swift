import Foundation
import AppIntents

// Hands-free food/weight logging via Siri, built into the app.
// "Hey Siri, log food in NutriChat" → Siri asks what you ate → reads it back →
// you say yes → it's logged to your diary. No Shortcut building required.

@available(iOS 16.0, *)
enum NutriChatAPI {
    static let endpoint = URL(string: "https://nutrichat-pwa.vercel.app/api/siri")!

    static func call(action: String, key: String, text: String?) async throws -> [String: Any] {
        var body: [String: Any] = ["action": action, "key": key]
        if let text = text { body["text"] = text }
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await URLSession.shared.data(for: req)
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    // The Siri key the app saved via Capacitor Preferences (group "CapacitorStorage").
    static var siriKey: String? {
        let k = UserDefaults.standard.string(forKey: "CapacitorStorage.siri_key")
        return (k?.isEmpty == false) ? k : nil
    }
}

@available(iOS 16.0, *)
struct LogFoodIntent: AppIntent {
    static var title: LocalizedStringResource = "Log Food"
    static var description = IntentDescription("Log food or weight to NutriChat by voice.")
    // Run in the background — don't open the app.
    static var openAppWhenRun: Bool = false

    @Parameter(title: "What did you eat or weigh?", requestValueDialog: "What did you eat or weigh?")
    var phrase: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let key = NutriChatAPI.siriKey else {
            return .result(dialog: "Open NutriChat and tap Link Siri to set this up first.")
        }

        // 1) Parse what was said (food or weight) — server reads it back.
        let parsed = try await NutriChatAPI.call(action: "parse", key: key, text: phrase)
        let found = (parsed["found"] as? Bool) ?? false
        let speak = (parsed["speak"] as? String) ?? "I couldn't catch that."
        if !found {
            return .result(dialog: "\(speak)")
        }

        // 2) Read it back and wait for a yes/no. Cancel = don't add.
        do {
            try await requestConfirmation(result: .result(dialog: "\(speak)"))
        } catch {
            return .result(dialog: "Okay, I won't add it.")
        }

        // 3) Confirmed → commit to the diary.
        let committed = try await NutriChatAPI.call(action: "commit", key: key, text: nil)
        let done = (committed["speak"] as? String) ?? "Added to your diary."
        return .result(dialog: "\(done)")
    }
}

@available(iOS 16.0, *)
struct NutriChatAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: LogFoodIntent(),
            phrases: [
                "Log food in \(.applicationName)",
                "Log a meal in \(.applicationName)",
                "Add food in \(.applicationName)"
            ],
            shortTitle: "Log Food",
            systemImageName: "fork.knife"
        )
    }
}
