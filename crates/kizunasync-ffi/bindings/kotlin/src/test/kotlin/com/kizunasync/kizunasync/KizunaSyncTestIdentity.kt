package com.kizunasync.kizunasync

/**
 * The fixed device identity every suite creates under. [KizunaSyncClient.create]
 * refuses anything that is not a uuid, because the server's registry column is
 * one. It lives in `src/test` rather than beside the generated-binding suites,
 * so the plain JVM lane compiles it even when bindgen has not run.
 */
const val KSYNC_TEST_CLIENT_ID = "00000000-0000-4000-8000-0000000000c1"

/**
 * The owner of a row that carries an attachment. [KizunaSyncClient.fromFile]
 * refuses a reference whose owner or key segment is not a uuid.
 */
const val KSYNC_TEST_OWNER = "00000000-0000-4000-8000-0000000000a1"

/** The primary key of the row [KSYNC_TEST_OWNER] owns. */
const val KSYNC_TEST_ROW_ID = "00000000-0000-4000-8000-0000000000b1"

/**
 * The remote the suites create with: the packaged build requires one, and a
 * build without `http` refuses any. Nothing listens at the address, so a test
 * that needs a push to land skips on this build.
 */
val KSYNC_TEST_REMOTE = KizunaSyncRemoteConfig(url = "https://127.0.0.1:1", publishableKey = "pub-xxx")
