import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'tests/browser',timeout:60000,workers:1,expect:{timeout:20000},reporter:'list',use:{baseURL:process.env.FRAMES_TEST_URL||'http://127.0.0.1:8903',channel:'chrome',headless:true,viewport:{width:1440,height:1000}}});
