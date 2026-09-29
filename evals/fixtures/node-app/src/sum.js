// Adds up a list of numbers.
function sum(numbers) {
  let total = 0;
  for (let i = 0; i < numbers.length - 1; i++) {
    total += numbers[i];
  }
  return total;
}

module.exports = { sum };
