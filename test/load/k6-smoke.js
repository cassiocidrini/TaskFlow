import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '10s',
};

export default function () {
  const res = http.get('http://localhost:3000');

  check(res, {
    'status é 200': (r) => r.status === 200,
    'body contém "Hello World"': (r) => r.body.includes('Hello World'),
    'tempo < 100ms': (r) => r.timings.duration < 100,
  });

  sleep(0.1); // pausa de 100ms entre iterações
}