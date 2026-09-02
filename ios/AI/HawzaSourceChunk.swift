import Foundation

struct HawzaSourceChunk: Identifiable, Hashable {
    let id: String
    let sourceID: String
    let title: String
    let author: String
    let category: String
    let page: Int?
    let chapter: String?
    let topic: String?
    let text: String
}
