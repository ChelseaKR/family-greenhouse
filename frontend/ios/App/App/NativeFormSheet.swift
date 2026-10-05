import SwiftUI
import UIKit

// A web form drawn as a native sheet (NativeChrome `presentForm`): a grouped
// form in a sheet with a grabber, medium and large detents, and Cancel and the
// submit button in the sheet's own navigation bar. What it may report is
// decided in NativeFormSheetModel.swift.

/// The values as the person changes them.
final class FormSheetState: ObservableObject {
    @Published var values: [String: FormSheetValue]
    init(_ values: [String: FormSheetValue]) { self.values = values }

    func text(_ id: String) -> Binding<String> {
        Binding(
            get: {
                if case .text(let text)? = self.values[id] { return text }
                return ""
            },
            set: { self.values[id] = .text($0) }
        )
    }

    func number(_ id: String, min: Int) -> Binding<Int> {
        Binding(
            get: {
                if case .number(let number)? = self.values[id] { return number }
                return min
            },
            set: { self.values[id] = .number($0) }
        )
    }
}

struct FormSheetView: View {
    let request: FormSheetRequest
    @ObservedObject var state: FormSheetState

    var body: some View {
        Form {
            if let message = request.message {
                Section {
                    Text(message).foregroundColor(.red)
                }
            }
            ForEach(request.fields.filter { request.isVisible($0, in: state.values) }, id: \.id) { field in
                fieldView(field)
            }
        }
    }

    @ViewBuilder
    private func fieldView(_ field: FormSheetField) -> some View {
        switch field {
        case .choice(let id, let label, let options, _):
            Section {
                Picker(label, selection: state.text(id)) {
                    ForEach(options, id: \.id) { option in
                        Text(option.title).tag(option.id)
                    }
                }
            }
        case .stepper(let id, let label, _, let min, let max, let one, let other):
            Section(header: Text(label)) {
                let value = state.number(id, min: min)
                Stepper(value: value, in: min...max) {
                    Text(FormSheetRequest.stepperWords(one: one, other: other, value: value.wrappedValue))
                }
                .accessibilityIdentifier("formsheet-\(id)")
            }
        case .text(let id, let label, _, let placeholder, let multiline, _, let maxLength, _):
            Section(header: Text(label)) {
                let binding = Binding<String>(
                    get: { state.text(id).wrappedValue },
                    set: { state.text(id).wrappedValue = String($0.prefix(maxLength)) }
                )
                if multiline {
                    TextEditor(text: binding)
                        .frame(minHeight: 88)
                        .accessibilityLabel(label)
                } else {
                    TextField(placeholder ?? label, text: binding)
                        .accessibilityLabel(label)
                }
            }
        }
    }
}

/// The sheet: a navigation controller around the SwiftUI form, presented as a
/// page sheet. Every way it can end goes through `outcome`.
final class FormSheetController: UINavigationController, UIAdaptivePresentationControllerDelegate {
    let token: String
    let request: FormSheetRequest
    private let state: FormSheetState
    private(set) var outcome: FormSheetOutcome?
    private var watch: Any?

    init(request: FormSheetRequest, token: String, outcome: FormSheetOutcome) {
        self.token = token
        self.request = request
        self.state = FormSheetState(request.initialValues)
        self.outcome = outcome
        let form = UIHostingController(rootView: FormSheetView(request: request, state: state))
        super.init(rootViewController: form)

        form.navigationItem.title = request.title
        form.navigationItem.leftBarButtonItem = UIBarButtonItem(
            title: request.cancel, style: .plain, target: self, action: #selector(cancelTapped))
        let submit = UIBarButtonItem(
            title: request.submit, style: .done, target: self, action: #selector(submitTapped))
        form.navigationItem.rightBarButtonItem = submit
        submit.isEnabled = request.canSubmit(state.values)
        // The submit button follows the form: off while a required field shows
        // and is empty.
        watch = state.$values.sink { [weak submit, request] values in
            submit?.isEnabled = request.canSubmit(values)
        }

        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
            sheet.prefersScrollingExpandsWhenScrolledToEdge = true
        }
        presentationController?.delegate = self
        view.tintColor = FrameColors.tint
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    @objc func cancelTapped() {
        outcome?.cancel()
        dismiss(animated: true)
    }

    @objc func submitTapped() {
        guard let outcome = outcome else { return }
        outcome.submit(request, values: state.values)
        // A submit that was refused (a required field empty) leaves it open.
        if outcome.answered { dismiss(animated: true) }
    }

    /// Swiped down (or dismissed some other way the system offers): no values.
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        outcome?.cancel()
    }

    /// Closed by the app (the web closed it, another one replaced it): no
    /// values, then away.
    func close(animated: Bool) {
        outcome?.cancel()
        if presentingViewController != nil, !isBeingDismissed {
            dismiss(animated: animated)
        }
    }

    /// For the simulator tour and tests only: the values it would send now.
    var currentValues: [String: FormSheetValue] { state.values }
    func setValue(_ value: FormSheetValue, for id: String) { state.values[id] = value }
}
