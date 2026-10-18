console.log('1. Início');

// Macrotask (Timers)
setTimeout(() => {
  console.log('2. setTimeout');
}, 0);

// Microtask (Promise)
Promise.resolve().then(() => {
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