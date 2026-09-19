import UIKit
import Capacitor

/// Capacitor's bridge view controller, plus the plugins that live in this app
/// target instead of an npm package. Main.storyboard names this class, so it
/// is the one iOS creates at launch.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PrintPlugin())
    }
}
