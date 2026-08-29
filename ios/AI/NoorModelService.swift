import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

enum NoorModelError: LocalizedError {
    case frameworkUnavailable
    case modelUnavailable(String)

    var errorDescription: String? {
        switch self {
        case .frameworkUnavailable:
            return "Apple Foundation Models are not available in this build."
        case .modelUnavailable(let reason):
            return "The on-device Apple model is unavailable: \(reason)"
        }
    }
}

actor NoorModelService {
    func availabilityDescription() -> String? {
        #if canImport(FoundationModels)
        guard #available(iOS 26.0, *) else {
            return "This version of iOS does not support Apple Foundation Models."
        }
        return availabilityDescriptionOnSupportedOS()
        #else
        return "FoundationModels framework is unavailable in this SDK."
        #endif
    }

    func answer(prompt: String) async throws -> String {
        #if canImport(FoundationModels)
        guard #available(iOS 26.0, *) else {
            throw NoorModelError.frameworkUnavailable
        }
        return try await answerOnSupportedOS(prompt: prompt)
        #else
        throw NoorModelError.frameworkUnavailable
        #endif
    }

    #if canImport(FoundationModels)
    @available(iOS 26.0, *)
    private func availabilityDescriptionOnSupportedOS() -> String? {
        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            return nil
        case .unavailable(.deviceNotEligible):
            return "This device is not eligible for Apple Intelligence."
        case .unavailable(.modelNotReady):
            return "The Apple Intelligence model is not ready on this device."
        case .unavailable(let reason):
            return "Apple Foundation Models are unavailable: \(reason)"
        }
    }

    @available(iOS 26.0, *)
    private func answerOnSupportedOS(prompt: String) async throws -> String {
        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            break
        case .unavailable(.deviceNotEligible):
            throw NoorModelError.modelUnavailable("device not eligible")
        case .unavailable(.modelNotReady):
            throw NoorModelError.modelUnavailable("model not ready")
        case .unavailable(let reason):
            throw NoorModelError.modelUnavailable(String(describing: reason))
        }

        // A fresh session keeps retrieved source context focused on the current
        // grounded question and avoids unlimited transcript growth.
        let session = LanguageModelSession(
            model: model,
            instructions: NoorInstructions.core
        )

        let response = try await session.respond(to: prompt)
        return response.content
    }
    #endif
}
