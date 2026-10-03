/**
 * The default SwiftPM build system archives an object file for every target, so
 * a header-only target fails the host build. This one definition gives the
 * module its object.
 */
const char kizunasync_ffiFFI_module[] = "kizunasync_ffiFFI";
