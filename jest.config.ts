import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';
import ts from 'typescript';

const { config: tsconfig } = ts.readConfigFile('./tsconfig.json', ts.sys.readFile);
const paths = tsconfig?.compilerOptions?.paths ?? {};

const baseConfig: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  moduleNameMapper: pathsToModuleNameMapper(paths, { prefix: '<rootDir>/' }),
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
};

const config: Config = {
  projects: [
    {
      ...baseConfig,
      displayName: 'unit',
      testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
      setupFiles: ['<rootDir>/test/setup.ts'],
      // timeout default do Jest (5 s): unitário lento é bug e deve falhar rápido
    },
    {
      ...baseConfig,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
      setupFiles: ['<rootDir>/test/setup.ts'],
      // `testTimeout` dentro de `projects` é IGNORADO pelo Jest — por isso o setup file (60 s, testes e hooks)
      setupFilesAfterEnv: ['<rootDir>/test/setup-slow-suites.ts'],
    },
    {
      ...baseConfig,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
      setupFiles: ['<rootDir>/test/setup.ts'],
      setupFilesAfterEnv: ['<rootDir>/test/setup-slow-suites.ts'],
    },
  ],
};

export default config;