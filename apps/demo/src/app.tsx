import { ConsentBanner } from '@kizunasync/ui'
import { CaptchaGate } from '@/components/captcha-gate'
import { DemoFooter } from '@/components/demo-footer'
import { DemoHeader } from '@/components/demo-header'
import { DemoMain } from '@/components/demo-main'
import { captchaGate, useDemo } from '@/lib/use-demo'
import { GTM_ID, TURNSTILE_SITE_KEY } from '@/runtime/demo-config'

export default function App() {
  const { demo, bootError, status, runningScenario, onStatus, runConflict, runEditAndSoftDelete } = useDemo()

  return (
    <>
      <CaptchaGate gate={captchaGate} siteKey={TURNSTILE_SITE_KEY}>
        <div className="flex min-h-screen flex-col">
          <DemoHeader
            disabled={demo === null || runningScenario}
            runningScenario={runningScenario}
            status={status}
            onRunConflict={runConflict}
            onRunEditAndSoftDelete={runEditAndSoftDelete}
          />
          <DemoMain demo={demo} bootError={bootError} onStatus={onStatus} />
          <DemoFooter />
        </div>
      </CaptchaGate>
      <ConsentBanner gtmId={GTM_ID} />
    </>
  )
}
