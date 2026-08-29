import Foundation

struct HawzaAnswer: Sendable {
    let text: String
    let sources: [HawzaSourceChunk]
}

enum NoorAlHawzaError: LocalizedError {
    case noSources

    var errorDescription: String? {
        switch self {
        case .noSources:
            return "No sufficiently relevant approved local source was found."
        }
    }
}

actor NoorAlHawzaService {
    private let retrieval: any HawzaRetrievalServing
    private let model: NoorModelService

    init(
        retrieval: any HawzaRetrievalServing,
        model: NoorModelService = NoorModelService()
    ) {
        self.retrieval = retrieval
        self.model = model
    }

    static func live() throws -> NoorAlHawzaService {
        let db = try HawzaDatabase()
        return NoorAlHawzaService(
            retrieval: HawzaRetrievalService(database: db)
        )
    }

    func modelAvailabilityDescription() async -> String? {
        await model.availabilityDescription()
    }

    func ask(_ question: String) async throws -> HawzaAnswer {
        let trimmed = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return HawzaAnswer(text: "", sources: [])
        }

        let sources = try await retrieval.search(query: trimmed, limit: 6)

        guard !sources.isEmpty else {
            return HawzaAnswer(
                text: """
                لم أعثر في قاعدة المصادر الحوزوية المحلية المتاحة على مادة كافية \
                لإجابة موثقة عن هذا السؤال. يمكنك إعادة صياغة السؤال أو الرجوع إلى \
                مصدر مختص أو عالم موثوق.
                """,
                sources: []
            )
        }

        let sourceBlock = sources.map { source in
            let pageText = source.page.map(String.init) ?? "unknown"
            let chapterText = source.chapter ?? "unknown"
            return """
            [SOURCE \(source.id)]
            Title: \(source.title)
            Author: \(source.author.isEmpty ? "unknown" : source.author)
            Category: \(source.category)
            Chapter: \(chapterText)
            Page: \(pageText)
            Passage:
            \(source.text)
            """
        }.joined(separator: "\n\n---\n\n")

        let prompt = """
        USER QUESTION:
        \(trimmed)

        APPROVED SOURCES RETRIEVED LOCALLY:
        \(sourceBlock)

        TASK:
        Answer the user's question from the supplied approved passages.
        Do not invent evidence.
        Do not invent or alter quotations.
        Cite only source IDs that materially support the answer.
        If the passages do not actually establish the requested conclusion,
        say so instead of guessing.
        """

        let text = try await model.answer(prompt: prompt)

        // Source cards are derived from the retrieval result, not model-made
        // bibliography. A production version can parse used [SOURCE ...] IDs
        // and show only those; showing retrieved sources is safer than fabricated
        // metadata and works without requiring structured generation.
        return HawzaAnswer(text: text, sources: sources)
    }
}
