/**
 * main.tsx imports this module before anything else. The demo CSP admits no
 * inline script, so the Consent Mode defaults and the container loader run
 * from this bundled module, served from 'self' (@../../README.md).
 */
import { bootstrapTagManager } from '@kizunasync/ui/tag-manager'
import { GTM_ID } from '@/runtime/demo-config'

bootstrapTagManager(GTM_ID)
