import Foundation

protocol HawzaRetrievalServing: Sendable {
    func search(query: String, limit: Int) async throws -> [HawzaSourceChunk]
}

struct HawzaRetrievalService: HawzaRetrievalServing {
    private let database: HawzaDatabase

    init(database: HawzaDatabase) {
        self.database = database
    }

    func search(query: String, limit: Int = 6) async throws -> [HawzaSourceChunk] {
        try await Task.detached(priority: .userInitiated) {
            try database.search(query: query, limit: limit)
        }.value
    }
}
