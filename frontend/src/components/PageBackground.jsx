import { useLocation } from 'react-router-dom';
import LiquidChrome from './LiquidChrome';
import GradientWaves from './GradientWaves';
import GhostFibers from './GhostFibers';
import './PageBackground.css';

// Stable references so the WebGL effects don't tear down on every re-render.
const CHROME_COLOR = [0.1, 0.1, 0.1];

function Layer({ scrim, children }) {
  return (
    <div className="page-bg" aria-hidden="true">
      <div className="page-bg-layer">{children}</div>
      <div className="page-bg-scrim" style={{ background: `rgba(11, 10, 13, ${scrim})` }} />
    </div>
  );
}

export default function PageBackground() {
  const { pathname } = useLocation();

  if (pathname === '/' || pathname === '/login') {
    return (
      <Layer key="chrome" scrim={0.55}>
        <LiquidChrome baseColor={CHROME_COLOR} speed={0.3} amplitude={0.3} interactive />
      </Layer>
    );
  }

  if (pathname === '/verify') {
    return (
      <Layer key="waves" scrim={0.45}>
        <GradientWaves
          horizonColor="#5227FF"
          waveColor="#FF9FFC"
          crestColor="#FFFFFF"
          speed={1.45}
          amplitude={3.6}
          waveScale={0.85}
          waveRatio={0.9}
          swell={35}
          turbulence={26.5}
          tilt={1.11}
          zoom={1.7}
          height={5.5}
          fogDepth={15}
          detail="high"
          brightness={1}
          opacity={1}
          mouseInteraction
          parallaxStrength={0.76}
          grain
          grainIntensity={0.17}
        />
      </Layer>
    );
  }

  if (pathname === '/config') {
    return (
      <Layer key="fibers" scrim={0.2}>
        <GhostFibers
          lineColor="#140E35"
          glowColor="#3437A0"
          speed={0.78}
          scale={2}
          rotation={35}
          rotationSpeed={0.25}
          layers={7}
          waveAmplitude={0.205}
          waveFrequency={3.85}
          waveSpeed={0.6}
          layerSpeed={0.08}
          twist={0.24}
          twistFrequency={5}
          twistSpeed={1.2}
          lineFrequency={5}
          lineSpacing={2}
          lineSharpness={16}
          glowFalloff={10}
          glowIntensity={1.6}
          brightness={2.45}
          blueBoost={1.25}
          vignette={0.8}
          grain={0.085}
          dpr={2}
          lightMode={false}
          fps={60}
          paused={false}
        />
      </Layer>
    );
  }

  return null;
}
