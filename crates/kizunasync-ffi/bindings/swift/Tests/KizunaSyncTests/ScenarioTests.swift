import XCTest
@testable import KizunaSync
import KizunaSyncScenarioSupport

final class ScenarioTests: XCTestCase {
  func testScenarioFileDecodesFromRepo() throws {
    let file = try loadScenarioFile()
    try KizunaSyncScenarios.validateStructure(file)
    XCTAssertGreaterThanOrEqual(file.scenarios.count, 12, "shared oracle shrank")
  }

  // Fail-loud: no embedded fallback, so a missing oracle cannot silently
  // downgrade this suite to a single hard-coded scenario.
  private func loadScenarioFile() throws -> ScenarioFile {
    try KizunaSyncScenarios.loadFromRepo()
  }
}
