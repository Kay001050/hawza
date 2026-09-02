import SwiftUI

struct HawzaChatView: View {
    @State private var model = HawzaChatViewModel()

    var body: some View {
        VStack(spacing: 0) {
            if let setupError = model.setupError {
                ContentUnavailableView(
                    "تعذر تحميل قاعدة نور الحوزة",
                    systemImage: "exclamationmark.triangle",
                    description: Text(setupError)
                )
            } else {
                if let reason = model.modelUnavailableReason {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "iphone.slash")
                        Text(reason)
                            .font(.footnote)
                        Spacer()
                    }
                    .padding()
                    .background(.thinMaterial)
                }

                messagesView

                Divider()

                composer
            }
        }
        .navigationTitle("نور الحوزة")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var messagesView: some View {
        ScrollView {
            LazyVStack(spacing: 14) {
                if model.messages.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "text.bubble")
                            .font(.largeTitle)
                        Text("اسأل نور الحوزة")
                            .font(.headline)
                        Text("تُبحث المصادر المحلية أولًا، ثم تُصاغ الإجابة على الجهاز.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 50)
                }

                ForEach(model.messages) { message in
                    messageView(message)
                }

                if model.isGenerating {
                    HStack {
                        ProgressView()
                        Text("جارٍ البحث والصياغة…")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Spacer()
                    }
                }
            }
            .padding()
        }
    }

    @ViewBuilder
    private func messageView(_ message: ChatMessage) -> some View {
        HStack(alignment: .top) {
            if message.role == .user {
                Spacer(minLength: 44)
            }

            VStack(alignment: .leading, spacing: 10) {
                Text(message.text)
                    .textSelection(.enabled)

                if !message.sources.isEmpty {
                    Divider()
                    Text("المصادر المحلية")
                        .font(.caption.bold())

                    ForEach(message.sources) { source in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(source.title)
                                .font(.caption.bold())

                            HStack(spacing: 6) {
                                if let page = source.page {
                                    Text("ص \(page)")
                                }
                                if !source.author.isEmpty {
                                    Text(source.author)
                                }
                            }
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .padding(12)
            .background(
                message.role == .user
                    ? Color.accentColor.opacity(0.14)
                    : Color.secondary.opacity(0.10)
            )
            .clipShape(RoundedRectangle(cornerRadius: 16))

            if message.role == .assistant {
                Spacer(minLength: 44)
            }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField(
                "اكتب سؤالك…",
                text: $model.input,
                axis: .vertical
            )
            .lineLimit(1...5)
            .textFieldStyle(.roundedBorder)
            .submitLabel(.send)
            .onSubmit {
                model.send()
            }

            Button(action: model.send) {
                Image(systemName: "paperplane.fill")
                    .font(.title3)
            }
            .disabled(
                model.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || model.isGenerating
                || model.modelUnavailableReason != nil
            )
            .accessibilityLabel("إرسال")
        }
        .padding()
    }
}
