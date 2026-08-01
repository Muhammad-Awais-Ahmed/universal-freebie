declare namespace NodeJS {
  interface Process {
    versions: { electron: string };
    platform: string;
  }
}

interface Window {
  require: (module: string) => any;
}
