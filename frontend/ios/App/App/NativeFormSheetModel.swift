import Foundation

// Native form sheets for the web (NativeChrome's `presentForm`), the part that
// decides, in plain Swift with no UIKit, so it compiles and runs on its own
// with `swiftc` (see docs/mobile.md, "Form sheets").
//
// The web owns the words, the choices and the starting values; Swift draws
// them in a sheet and hands the values back. The one rule this file exists to
// keep, as NativePresentModel.swift does for alerts: values are reported ONLY
// when the person tapped the sheet's own submit button with every required
// field filled in. Every other way the sheet can end (Cancel, a swipe down,
// the web closing it, another sheet or alert replacing it, the controller
// going away) reports nil, and nothing can report twice.

/// One field of a form sheet.
enum FormSheetField: Equatable {
    /// A pick-one list (a task's kind).
    case choice(id: String, label: String, options: [FormSheetOption], value: String)
    /// A whole number with − and + (how many days between).
    case stepper(id: String, label: String, value: Int, min: Int, max: Int,
                 one: String, other: String)
    /// Words. `required` only counts while the field shows; `visibleWhen` shows
    /// it only while another field holds a given value ("Custom" → its name).
    case text(id: String, label: String, value: String, placeholder: String?,
              multiline: Bool, required: Bool, maxLength: Int, visibleWhen: FormSheetCondition?)

    var id: String {
        switch self {
        case .choice(let id, _, _, _), .stepper(let id, _, _, _, _, _, _),
             .text(let id, _, _, _, _, _, _, _):
            return id
        }
    }
}

struct FormSheetOption: Equatable {
    let id: String
    let title: String
}

struct FormSheetCondition: Equatable {
    let field: String
    let equals: String
}

/// A field's current value.
enum FormSheetValue: Equatable {
    case text(String)
    case number(Int)

    var asAny: Any {
        switch self {
        case .text(let text): return text
        case .number(let number): return number
        }
    }
}

struct FormSheetRequest: Equatable {
    let title: String
    /// Shown above the fields: why a submit came back (the server refused it).
    let message: String?
    let cancel: String
    let submit: String
    let fields: [FormSheetField]

    static let maxFields = 12

    /// Reads a request as the plugin receives it. Returns the request, or why
    /// it was refused; a refused request is never shown.
    static func parse(_ raw: [String: Any]) -> (request: FormSheetRequest?, error: String?) {
        func words(_ key: String) -> String? {
            let text = (raw[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return (text ?? "").isEmpty ? nil : text
        }
        guard let title = words("title"), let cancel = words("cancel"), let submit = words("submit")
        else { return (nil, "a form sheet needs a title, cancel and submit") }
        guard let rawFields = raw["fields"] as? [[String: Any]], !rawFields.isEmpty,
              rawFields.count <= maxFields
        else { return (nil, "between 1 and \(maxFields) fields") }

        var fields: [FormSheetField] = []
        var ids = Set<String>()
        for item in rawFields {
            guard let id = item["id"] as? String, !id.isEmpty, ids.insert(id).inserted,
                  let label = item["label"] as? String, !label.isEmpty,
                  let kind = item["kind"] as? String
            else { return (nil, "every field needs a unique id, a label and a kind") }
            switch kind {
            case "choice":
                let options = (item["options"] as? [[String: Any]] ?? []).compactMap { option -> FormSheetOption? in
                    guard let id = option["id"] as? String, let title = option["title"] as? String,
                          !id.isEmpty, !title.isEmpty else { return nil }
                    return FormSheetOption(id: id, title: title)
                }
                guard !options.isEmpty, let value = item["value"] as? String,
                      options.contains(where: { $0.id == value })
                else { return (nil, "a choice needs options and one of them as its value") }
                fields.append(.choice(id: id, label: label, options: options, value: value))
            case "stepper":
                guard let min = (item["min"] as? NSNumber)?.intValue,
                      let max = (item["max"] as? NSNumber)?.intValue, min <= max,
                      let value = (item["value"] as? NSNumber)?.intValue,
                      let one = item["one"] as? String, let other = item["other"] as? String
                else { return (nil, "a stepper needs min <= max, a value and its words") }
                fields.append(.stepper(id: id, label: label, value: Swift.min(max, Swift.max(min, value)),
                                       min: min, max: max, one: one, other: other))
            case "text":
                var condition: FormSheetCondition?
                if let when = item["visibleWhen"] as? [String: Any] {
                    guard let field = when["field"] as? String, let equals = when["equals"] as? String
                    else { return (nil, "visibleWhen needs a field and a value") }
                    condition = FormSheetCondition(field: field, equals: equals)
                }
                fields.append(.text(
                    id: id, label: label, value: item["value"] as? String ?? "",
                    placeholder: item["placeholder"] as? String,
                    multiline: item["multiline"] as? Bool ?? false,
                    required: item["required"] as? Bool ?? false,
                    maxLength: (item["maxLength"] as? NSNumber)?.intValue ?? 500,
                    visibleWhen: condition
                ))
            default:
                return (nil, "kind must be choice, stepper or text")
            }
        }
        // A condition must name a field that exists, or the field could never show.
        for case .text(_, _, _, _, _, _, _, let condition?) in fields
        where !ids.contains(condition.field) {
            return (nil, "visibleWhen names no field")
        }
        return (FormSheetRequest(title: title, message: words("message"), cancel: cancel,
                                 submit: submit, fields: fields), nil)
    }

    /// The values the sheet starts with.
    var initialValues: [String: FormSheetValue] {
        var values: [String: FormSheetValue] = [:]
        for field in fields {
            switch field {
            case .choice(let id, _, _, let value): values[id] = .text(value)
            case .stepper(let id, _, let value, _, _, _, _): values[id] = .number(value)
            case .text(let id, _, let value, _, _, _, _, _): values[id] = .text(value)
            }
        }
        return values
    }

    /// Whether a field shows, given the values now.
    func isVisible(_ field: FormSheetField, in values: [String: FormSheetValue]) -> Bool {
        guard case .text(_, _, _, _, _, _, _, let condition?) = field else { return true }
        return values[condition.field] == .text(condition.equals)
    }

    /// The submit button works only when this is true: every required field
    /// that shows has words in it.
    func canSubmit(_ values: [String: FormSheetValue]) -> Bool {
        for field in fields where isVisible(field, in: values) {
            if case .text(let id, _, _, _, _, true, _, _) = field {
                guard case .text(let text)? = values[id],
                      !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                else { return false }
            }
        }
        return true
    }

    /// What a submit reports: the shown fields' values (a hidden field is not
    /// sent, so a name typed for "Custom" and then abandoned goes nowhere).
    func submitted(_ values: [String: FormSheetValue]) -> [String: Any] {
        var out: [String: Any] = [:]
        for field in fields where isVisible(field, in: values) {
            if let value = values[field.id] { out[field.id] = value.asAny }
        }
        return out
    }

    /// The words beside a stepper for a value: "Every day", "Every 3 days".
    static func stepperWords(one: String, other: String, value: Int) -> String {
        value == 1 ? one : other.replacingOccurrences(of: "{n}", with: String(value))
    }
}

/// How one form sheet ended. Answers exactly once: the values on a submit,
/// nil any other way.
final class FormSheetOutcome {
    private(set) var answered = false
    private let completion: ([String: Any]?) -> Void

    init(completion: @escaping ([String: Any]?) -> Void) {
        self.completion = completion
    }

    /// The submit button, with the request it belongs to and the values now.
    /// A submit while a required field is empty reports nothing (the button
    /// is disabled then; this is the second lock).
    func submit(_ request: FormSheetRequest, values: [String: FormSheetValue]) {
        guard request.canSubmit(values) else { return }
        finish(request.submitted(values))
    }

    /// Cancel, a swipe down, the web closing it, replaced, backgrounded.
    func cancel() {
        finish(nil)
    }

    private func finish(_ values: [String: Any]?) {
        guard !answered else { return }
        answered = true
        completion(values)
    }

    /// The sheet went away without an answer: no values, never a hanging
    /// promise.
    deinit {
        if !answered { completion(nil) }
    }
}
