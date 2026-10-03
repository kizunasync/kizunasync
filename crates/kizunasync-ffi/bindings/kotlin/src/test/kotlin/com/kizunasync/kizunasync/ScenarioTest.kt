package com.kizunasync.kizunasync

import kotlin.test.Test
import kotlin.test.assertTrue

/** Validates the shared scenario oracle that the generated-binding tests consume. */
class ScenarioTest {
    @Test
    fun scenariosFileIsPresentAndValid() {
        val root = KizunaSyncScenarios.loadFromRepo()
        KizunaSyncScenarios.validateStructure(root)
        val scenarios = root.getJSONArray("scenarios")
        assertTrue(scenarios.length() >= 12, "shared oracle shrank to ${scenarios.length()}")
    }
}
