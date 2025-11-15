import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default defineConfig([
    {
        ignores: ['dist', 'node_modules', 'eslint.config.ts'],
    },
    {
        files: ['**/*.{ts,tsx,js,jsx}'],
        extends: [
            js.configs.recommended,
            ...tseslint.configs.strictTypeChecked,
            ...tseslint.configs.stylisticTypeChecked, 
            stylistic.configs.recommended,
        ],
        languageOptions: {
            parserOptions: {
                project: ['./tsconfig.eslint.json'],
                tsconfigRootDir: import.meta.dirname,
                ecmaFeatures: {
                    jsx: true,
                },
            },
        },
        rules: {
            'func-style': ['error', 'declaration', { allowArrowFunctions: false }],
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@stylistic/semi': ['error', 'always'],
            '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],
            '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
            '@stylistic/comma-dangle': 'off',
            '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
            '@stylistic/member-delimiter-style': ['error', {
                multiline: {
                    delimiter: 'comma',
                    requireLast: true
                },
                singleline: {
                    delimiter: 'comma',
                    requireLast: true
                },
                overrides: {
                    interface: {
                        multiline: {
                            delimiter: 'semi',
                            requireLast: true
                        }
                    }
                }
            }],
        },
    },
]);
