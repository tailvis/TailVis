import App from '../App'
import { createDemoState, DEMO_STORAGE_KEY, DEMO_EXAMPLES, getDemoRequests, restoreDemoState, requestDemoResponse } from '../data/guidedDemo'
import './GuidedDemo.css'

const config = { examples: DEMO_EXAMPLES, requests: getDemoRequests, restore: restoreDemoState, respond: requestDemoResponse }
export default function GuidedDemo() {
  return <App guidedDemo={config} initialState={createDemoState()} storageKey={DEMO_STORAGE_KEY} />
}
