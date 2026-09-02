import Foundation
import SQLite3

// SQLite needs this destructor marker when binding a Swift String temporarily.
private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

enum HawzaDatabaseError: LocalizedError {
    case databaseMissing
    case openFailed(String)
    case prepareFailed(String)
    case queryFailed(String)

    var errorDescription: String? {
        switch self {
        case .databaseMissing:
            return "hawza_knowledge.sqlite is missing from the app bundle."
        case .openFailed(let message):
            return "Could not open the Hawza database: \(message)"
        case .prepareFailed(let message):
            return "Could not prepare the Hawza search: \(message)"
        case .queryFailed(let message):
            return "Could not search the Hawza database: \(message)"
        }
    }
}

final class HawzaDatabase: @unchecked Sendable {
    private let db: OpaquePointer?

    init(bundle: Bundle = .main) throws {
        guard let url = bundle.url(
            forResource: "hawza_knowledge",
            withExtension: "sqlite"
        ) else {
            throw HawzaDatabaseError.databaseMissing
        }

        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX
        let rc = sqlite3_open_v2(url.path, &handle, flags, nil)

        guard rc == SQLITE_OK else {
            let message = handle.flatMap { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
            if handle != nil { sqlite3_close(handle) }
            throw HawzaDatabaseError.openFailed(message)
        }

        self.db = handle
    }

    deinit {
        if let db {
            sqlite3_close(db)
        }
    }

    func search(query: String, limit: Int = 6) throws -> [HawzaSourceChunk] {
        let match = Self.makeFTSQuery(query)
        guard !match.isEmpty else { return [] }

        let sql = """
        SELECT
            c.id,
            c.source_id,
            s.title,
            s.author,
            s.category,
            c.page,
            c.chapter,
            c.topic,
            c.text,
            bm25(chunks_fts) AS rank
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.chunk_id
        JOIN sources s ON s.id = c.source_id
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?;
        """

        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw HawzaDatabaseError.prepareFailed(errorMessage)
        }
        defer { sqlite3_finalize(statement) }

        sqlite3_bind_text(statement, 1, match, -1, sqliteTransient)
        sqlite3_bind_int(statement, 2, Int32(max(1, min(limit, 12))))

        var result: [HawzaSourceChunk] = []

        while true {
            let rc = sqlite3_step(statement)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else {
                throw HawzaDatabaseError.queryFailed(errorMessage)
            }

            let page: Int? = sqlite3_column_type(statement, 5) == SQLITE_NULL
                ? nil
                : Int(sqlite3_column_int(statement, 5))

            result.append(
                HawzaSourceChunk(
                    id: Self.string(statement, 0),
                    sourceID: Self.string(statement, 1),
                    title: Self.string(statement, 2),
                    author: Self.string(statement, 3),
                    category: Self.string(statement, 4),
                    page: page,
                    chapter: Self.optionalString(statement, 6),
                    topic: Self.optionalString(statement, 7),
                    text: Self.string(statement, 8)
                )
            )
        }

        return result
    }

    private var errorMessage: String {
        guard let db else { return "database unavailable" }
        return String(cString: sqlite3_errmsg(db))
    }

    private static func string(_ stmt: OpaquePointer?, _ index: Int32) -> String {
        guard let raw = sqlite3_column_text(stmt, index) else { return "" }
        return String(cString: raw)
    }

    private static func optionalString(_ stmt: OpaquePointer?, _ index: Int32) -> String? {
        guard sqlite3_column_type(stmt, index) != SQLITE_NULL else { return nil }
        let value = string(stmt, index)
        return value.isEmpty ? nil : value
    }

    private static func makeFTSQuery(_ query: String) -> String {
        let normalized = normalizeArabic(query)
        let parts = normalized
            .split { !$0.isLetter && !$0.isNumber }
            .map(String.init)
            .filter { $0.count > 1 }
            .prefix(12)

        return parts
            .map { "\"\($0.replacingOccurrences(of: "\"", with: ""))\"" }
            .joined(separator: " OR ")
    }

    private static func normalizeArabic(_ input: String) -> String {
        var value = input
            .precomposedStringWithCompatibilityMapping
            .replacingOccurrences(of: "ـ", with: "")

        let replacements: [String: String] = [
            "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا",
            "ى": "ي", "ؤ": "و", "ئ": "ي"
        ]
        for (from, to) in replacements {
            value = value.replacingOccurrences(of: from, with: to)
        }

        let scalars = value.unicodeScalars.filter { scalar in
            switch scalar.value {
            case 0x0610...0x061A, 0x064B...0x065F, 0x0670, 0x06D6...0x06ED:
                return false
            default:
                return true
            }
        }

        return String(String.UnicodeScalarView(scalars)).lowercased()
    }
}
