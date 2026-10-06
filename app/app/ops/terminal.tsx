// The terminal is a shell on the hub's own machine, so the demo shows where it
// lives instead (src/demo/ServerOnly.tsx).
import TerminalScreen from '../../src/terminal/TerminalScreen';
import { inDemo, TerminalDemo } from '../../src/demo/ServerOnly';

export default inDemo(TerminalScreen, TerminalDemo);
