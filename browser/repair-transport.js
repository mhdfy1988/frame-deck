// 只在静态构建的原精修器中注入；不覆盖全局fetch，不访问任何API。
export async function repairRequest(url, options = {}) {
  if (parent === window) throw new Error("请从帧工作台打开精修");
  const channel = new MessageChannel();
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("精修通信超时"));
    }, 30000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(data);
    };
    parent.postMessage(
      {
        kind: "browser-repair-request",
        url,
        method: options.method || "GET",
        body: options.body,
      },
      location.origin,
      [channel.port2],
    );
  });
  return {
    ok: result.ok,
    json: async () => result,
    blob: async () => {
      if (!result.ok) throw new Error(result.detail);
      return result.blob;
    },
  };
}
