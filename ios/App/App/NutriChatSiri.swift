import Foundation
import AppIntents

// Hands-free food/weight logging via Siri, built into the app.
// "Hey Siri, log food in NutriChat" → Siri asks what you ate → reads it back →
// you say yes → it's logged to your diary. No Shortcut building required.

@available(iOS 16.0, *)
enum NutriChatAPI {
    static let endpoint = URL(string: "https://nutrichat-pwa.vercel.app/api/siri")!

    static func call(action: String, key: String, text: String? = nil, date: String? = nil) async throws -> [String: Any] {
        var body: [String: Any] = ["action": action, "key": key]
        if let text = text { body["text"] = text }
        if let date = date { body["date"] = date }
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

    // Today's date in the device's timezone (so logs/queries hit the right day).
    static var localDate: String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: Date())
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
        var text = phrase
        var parsed = try await NutriChatAPI.call(action: "parse", key: key, text: text, date: NutriChatAPI.localDate)

        // If nothing recognised, ask once more (conversational retry).
        if !((parsed["found"] as? Bool) ?? false) {
            text = try await $phrase.requestValue("I didn't quite catch that. What did you eat, or what's your weight?")
            parsed = try await NutriChatAPI.call(action: "parse", key: key, text: text, date: NutriChatAPI.localDate)
        }

        let found = (parsed["found"] as? Bool) ?? false
        let speak = (parsed["speak"] as? String) ?? "I couldn't catch that."
        if !found {
            return .result(dialog: "\(speak)")
        }

        // 2) Read it back and wait for a yes/no. Cancel = don't add.
        do {
            try await requestConfirmation(result: .result(dialog: "\(speak)"))
        } catch {
            return .result(dialog: "No worries, I won't add it.")
        }

        // 3) Confirmed → commit to the diary.
        let committed = try await NutriChatAPI.call(action: "commit", key: key, text: nil)
        let done = (committed["speak"] as? String) ?? "Added to your diary."
        return .result(dialog: "\(done)")
    }
}

@available(iOS 16.0, *)
struct RemainingIntent: AppIntent {
    static var title: LocalizedStringResource = "What's Left Today"
    static var description = IntentDescription("Ask how many calories and macros you have left today.")
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let key = NutriChatAPI.siriKey else {
            return .result(dialog: "Open NutriChat and tap Link Siri to set this up first.")
        }
        let resp = try await NutriChatAPI.call(action: "remaining", key: key, text: nil, date: NutriChatAPI.localDate)
        let speak = (resp["speak"] as? String) ?? "I couldn't get your totals right now."
        return .result(dialog: "\(speak)")
    }
}

@available(iOS 16.0, *)
struct NutriChatAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: LogFoodIntent(),
            // Apple only allows fixed-list (AppEnum) values inline in phrases, not free
            // text — so these triggers prompt, then Siri asks what you ate / your weight.
            phrases: [
                "Log food in \(.applicationName)",
                "Log a meal in \(.applicationName)",
                "I ate something in \(.applicationName)",
                "Log my weight in \(.applicationName)",
                "Track my food in \(.applicationName)",
                "Tell \(.applicationName) what I ate"
            ],
            shortTitle: "Log Food",
            systemImageName: "fork.knife"
        )
        AppShortcut(
            intent: RemainingIntent(),
            phrases: [
                "How many calories are left in \(.applicationName)",
                "What's left in \(.applicationName)",
                "Calories left in \(.applicationName)",
                "What are my macros in \(.applicationName)",
                "How am I doing in \(.applicationName)"
            ],
            shortTitle: "What's Left Today",
            systemImageName: "flame"
        )
    }
}
