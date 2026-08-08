#!/usr/bin/env node
import { resolve } from 'node:path';
import { worktreeBinding } from './git-context.mjs';

const path = resolve(process.argv[2] ?? '.');
console.log(worktreeBinding(path));
