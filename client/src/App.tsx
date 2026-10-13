import { Canvas } from '@react-three/fiber';

export function App() {
  return (
    <Canvas style={{ position: 'fixed', inset: 0 }} camera={{ position: [0, 10, 10] }}>
      <ambientLight />
      <mesh>
        <boxGeometry />
        <meshLambertMaterial color="hotpink" />
      </mesh>
    </Canvas>
  );
}
