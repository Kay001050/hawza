import Foundation
import Observation

@MainActor
@Observable
final class HawzaChatViewModel {
    var messages: [ChatMessage] = []
    var input: String = ""
    var isGenerating = false
    var setupError: String?
    var modelUnavailableReason: String?

    private var service: NoorAlHawzaService?

    init() {
        do {
            self.service = try NoorAlHawzaService.live()
        } catch {
            self.setupError = error.localizedDescription
        }

        Task {
            if let service {
                modelUnavailableReason = await service.modelAvailabilityDescription()
            }
        }
    }

    func send() {
        let question = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !isGenerating else { return }
        guard let service else {
            setupError = setupError ?? "Noor Al-Hawza service is not configured."
            return
        }

        messages.append(
            ChatMessage(role: .user, text: question)
        )
        input = ""
        isGenerating = true

        Task {
            defer { isGenerating = false }

            do {
                let answer = try await service.ask(question)
                messages.append(
                    ChatMessage(
                        role: .assistant,
                        text: answer.text,
                        sources: answer.sources
                    )
                )
            } catch {
                messages.append(
                    ChatMessage(
                        role: .assistant,
                        text: "تعذر إنشاء الإجابة محليًا: \(error.localizedDescription)"
                    )
                )
            }
        }
    }
}
