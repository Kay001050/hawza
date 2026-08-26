import Foundation

struct ChatMessage: Identifiable, Hashable {
    enum Role: Hashable {
        case user
        case assistant
    }

    let id: UUID
    let role: Role
    let text: String
    let sources: [HawzaSourceChunk]
    let createdAt: Date

    init(
        id: UUID = UUID(),
        role: Role,
        text: String,
        sources: [HawzaSourceChunk] = [],
        createdAt: Date = .now
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.sources = sources
        self.createdAt = createdAt
    }
}
