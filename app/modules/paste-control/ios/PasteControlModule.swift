import ExpoModulesCore

public class PasteControlModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PasteControl")

    View(PasteControlView.self) {
      Events("onPasteImage", "onPasteFile", "onPasteError")
    }
  }
}
