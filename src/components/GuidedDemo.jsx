import App from '../App'
import { createDemoState, DEMO_STORAGE_KEY, DEMO_REQUESTS, requestDemoResponse } from '../data/guidedDemo'
import './GuidedDemo.css'

const config = { requests: DEMO_REQUESTS, respond: requestDemoResponse }
export default function GuidedDemo() {
  return <App guidedDemo={config} initialState={createDemoState()} storageKey={DEMO_STORAGE_KEY} />
}
