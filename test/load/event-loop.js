/**
 * Experimento: ordem de execução do Event Loop (Módulo 11). `node test/load/event-loop.js`.
 *
 * Sempre: síncrono → `process.nextTick` → Promises (microtasks). Já entre `setTimeout(0)` e `setImmediate`,
 * no script principal, a ordem é NÃO DETERMINÍSTICA (6 execuções deram 3 × 3); só dentro de um callback de
 * I/O o `setImmediate` vem sempre primeiro. Um resultado não é uma regra.
 */
console.log('1. Início');

// Macrotask (Timers)
setTimeout(() => {
  console.log('2. setTimeout');
}, 0);

// Microtask (Promise)
void Promise.resolve().then(() => {
  console.log('3. Promise');
});

// Microtask (process.nextTick) - PRIORIDADE MÁXIMA
process.nextTick(() => {
  console.log('4. process.nextTick');
});

// Macrotask (Check phase)
setImmediate(() => {
  console.log('5. setImmediate');
});

// Síncrono
console.log('6. Fim do sync');