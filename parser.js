const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs").promises;
const path = require("path");
const { URL } = require("url");

// Количество параллельных потоков для парсинга
const PARALLEL_THREADS = 10;

// Очередь для синхронизации записи в файл
let writeQueue = Promise.resolve();

/**
 * Загружает страницу и возвращает cheerio объект
 */
async function getPage(url) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  };

  try {
    const response = await axios.get(url, { headers, timeout: 10000 });
    return cheerio.load(response.data);
  } catch (error) {
    console.error(`Ошибка при загрузке ${url}:`, error.message);
    return null;
  }
}

/**
 * Получает все ссылки со страницы по селектору .blog-post ul li a
 */
async function getAllLinks(baseUrl) {
  const $ = await getPage(baseUrl);
  if (!$) {
    return [];
  }

  const links = [];
  const blogPost = $(".blog-post");

  if (blogPost.length > 0) {
    blogPost.find("ul li a").each((i, elem) => {
      const href = $(elem).attr("href");
      if (href) {
        try {
          const fullUrl = new URL(href, baseUrl).href;
          links.push(fullUrl);
        } catch (error) {
          console.error(`Ошибка при обработке ссылки ${href}:`, error.message);
        }
      }
    });
  }

  return links;
}

/**
 * Парсит страницу с вопросом и возвращает данные
 */
async function parseQuestionPage(url) {
  const $ = await getPage(url);
  if (!$) {
    return null;
  }

  // Извлекаем вопрос из h1.blog-post-title
  const questionElement = $("h1.blog-post-title");
  if (questionElement.length === 0) {
    console.log(`Не найден вопрос на странице ${url}`);
    return null;
  }

  const questionEn = questionElement.text().trim();

  // Извлекаем варианты ответов из таблицы
  // Из-за некорректного HTML используем регулярные выражения для парсинга
  const variantsEn = [];
  const table = $(".table.table-striped");

  if (table.length === 0) {
    console.log(`Таблица не найдена на странице ${url}`);
    return null;
  }

  console.log(`Таблица найдена на странице ${url}`);

  // Получаем HTML таблицы как строку
  const tableHtml = table.html() || "";

  console.log(`tableHtml: ${tableHtml}`);

  // Используем регулярное выражение для извлечения пар <td>текст</td><td>число</td>
  // Паттерн: <td>([^<]+)</td>\s*<td>(\d+)</td>
  const patternWithPoints = /<td>([^<]+)<\/td>\s*<td>(\d+)<\/td>/g;
  const matches = [];
  let match;

  while ((match = patternWithPoints.exec(tableHtml)) !== null) {
    matches.push([match[1], match[2]]);
  }

  console.log(`Найдено совпадений с points в таблице: ${matches.length}`);

  const seenVariants = new Set(); // Для избежания дублей

  // Если найдены пары с points, обрабатываем их
  if (matches.length > 0) {
    matches.forEach(([variantText, pointsText], idx) => {
      const variant = variantText.trim();
      const pointsTextTrimmed = pointsText.trim();

      console.log(
        `  Пара ${idx + 1}: Вариант: '${variant}', Очки: '${pointsTextTrimmed}'`
      );

      // Пропускаем пустые значения
      if (!variant || !pointsTextTrimmed) {
        console.log(`  ⚠ Пропущена пара с пустыми значениями`);
        return;
      }

      // Преобразуем points в число
      const points = parseInt(pointsTextTrimmed, 10);
      if (isNaN(points)) {
        console.log(
          `  ⚠ Не удалось преобразовать '${pointsTextTrimmed}' в число`
        );
        return;
      }

      // Проверяем на дубли (по варианту и очкам)
      const variantKey = `${variant}|${points}`;
      if (seenVariants.has(variantKey)) {
        console.log(`  ⚠ Пропущен дубль: ${variant} - ${points}`);
        return;
      }

      seenVariants.add(variantKey);
      variantsEn.push({
        variant: variant,
        points: points,
      });
      console.log(`  ✓ Добавлено: ${variant} - ${points}`);
    });
  } else {
    // Если points не указаны, парсим только варианты ответов
    console.log(`Points не найдены, парсим только варианты ответов`);
    
    // Паттерн для поиска вариантов ответов в строках tbody: <tr><td>текст</td>
    // Также учитываем случаи без закрывающего тега: <td>текст<td>
    const patternWithoutPoints = /<tr>\s*<td>([^<]+)<\/?td>/g;
    const variantMatches = [];
    let variantMatch;

    while ((variantMatch = patternWithoutPoints.exec(tableHtml)) !== null) {
      const variant = variantMatch[1].trim();
      if (variant) {
        variantMatches.push(variant);
      }
    }

    // Если не нашли через первый паттерн, пробуем более простой: <td>текст</td> или <td>текст<td>
    if (variantMatches.length === 0) {
      const simplePattern = /<td>([^<]+)<\/?td>/g;
      while ((variantMatch = simplePattern.exec(tableHtml)) !== null) {
        const variant = variantMatch[1].trim();
        // Пропускаем заголовки таблицы (Answer, Points и т.д.)
        if (variant && !variant.match(/^(Answer|Points)$/i)) {
          variantMatches.push(variant);
        }
      }
    }

    console.log(`Найдено вариантов ответов без points: ${variantMatches.length}`);

    if (variantMatches.length > 0) {
      // Присваиваем очки по убыванию: первый вариант = количество вариантов, второй = количество - 1, и т.д.
      variantMatches.forEach((variant, idx) => {
        // Проверяем на дубли (только по варианту, так как points будут разные)
        if (seenVariants.has(variant)) {
          console.log(`  ⚠ Пропущен дубль: ${variant}`);
          return;
        }

        const points = variantMatches.length - idx; // Первый = max, последний = 1
        seenVariants.add(variant);
        variantsEn.push({
          variant: variant,
          points: points,
        });
        console.log(`  ✓ Добавлено: ${variant} - ${points} (по убыванию)`);
      });
    }
  }

  if (variantsEn.length === 0) {
    console.log(`Не найдены варианты ответов на странице ${url}`);
    return null;
  }

  return {
    url: url,
    question_en: questionEn,
    variants_en: variantsEn,
  };
}

/**
 * Сохраняет результаты в JSON файл (синхронизированная запись)
 */
async function saveResults(results, outputFile) {
  // Добавляем операцию записи в очередь
  writeQueue = writeQueue.then(async () => {
    const jsonData = JSON.stringify(results, null, 2);
    await fs.writeFile(outputFile, jsonData, "utf-8");
  });
  await writeQueue;
}

/**
 * Загружает существующие результаты из JSON файла
 */
async function loadExistingResults(outputFile) {
  try {
    const data = await fs.readFile(outputFile, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      // Файл не существует
      return [];
    } else if (error instanceof SyntaxError) {
      console.log(
        `⚠ Ошибка при чтении ${outputFile}, начинаем с пустого списка`
      );
      return [];
    }
    throw error;
  }
}

/**
 * Задержка в миллисекундах
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Обрабатывает одну ссылку с проверкой на дубли
 */
async function processLink(link, existingUrls, results, outputFile) {
  // Проверяем на дубли по url
  if (existingUrls.has(link)) {
    console.log(`⚠ Пропущен дубль по URL: ${link}`);
    return false;
  }

  try {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Обработка: ${link}`);
    console.log("=".repeat(60));

    await sleep(100); // Задержка перед загрузкой страницы (100 миллисекунд)

    const data = await parseQuestionPage(link);
    if (data) {
      // Добавляем в Set существующих URL
      existingUrls.add(link);
      results.push(data);
      // Сразу сохраняем в файл после обработки каждой страницы
      await saveResults(results, outputFile);
      console.log(
        `\n✓ Данные сохранены в ${outputFile} (всего записей: ${results.length})`
      );
      return true;
    } else {
      console.log(`⚠ Не удалось получить данные со страницы ${link}`);
      return false;
    }
  } catch (error) {
    console.log(`\n✗ Ошибка при обработке ${link}:`, error.message);
    console.error(error.stack);
    return false;
  }
}

/**
 * Главная функция
 */
async function main() {
  const baseUrl = "https://www.familyfeudfriends.com/answers/";
  const outputFile = "data.json";

  console.log("Загрузка главной страницы...");
  const links = await getAllLinks(baseUrl);
  console.log(`Найдено ссылок: ${links.length}`);

  if (links.length === 0) {
    console.log("Не найдено ссылок для парсинга!");
    return;
  }

  // Загружаем существующие результаты
  const results = await loadExistingResults(outputFile);
  console.log(`Загружено существующих записей: ${results.length}`);
  
  // Создаем Set существующих URL для быстрой проверки дублей
  const existingUrls = new Set();
  results.forEach((item) => {
    if (item.url) {
      existingUrls.add(item.url);
    }
  });
  console.log(`Найдено уникальных URL в существующих данных: ${existingUrls.size}`);
  
  // Фильтруем ссылки, исключая уже обработанные
  const linksToProcess = links.filter((link) => !existingUrls.has(link));
  console.log(`Будет обработано новых ссылок: ${linksToProcess.length} из ${links.length}`);

  // Обрабатываем ссылки параллельными батчами
  let processedCount = 0;
  for (let i = 0; i < linksToProcess.length; i += PARALLEL_THREADS) {
    const batch = linksToProcess.slice(i, i + PARALLEL_THREADS);
    console.log(
      `\nОбработка батча ${Math.floor(i / PARALLEL_THREADS) + 1} (${i + 1}-${Math.min(i + PARALLEL_THREADS, linksToProcess.length)}/${linksToProcess.length})`
    );

    // Обрабатываем батч параллельно
    const promises = batch.map((link) =>
      processLink(link, existingUrls, results, outputFile)
    );
    const batchResults = await Promise.all(promises);
    processedCount += batchResults.filter((r) => r).length;

    // Небольшая задержка между батчами, чтобы не перегружать сервер
    if (i + PARALLEL_THREADS < linksToProcess.length) {
      await sleep(500);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `Парсинг завершен! Обработано ${processedCount} новых вопросов из ${linksToProcess.length} новых ссылок.`
  );
  console.log(`Всего записей в файле: ${results.length}`);
  console.log(`Данные сохранены в ${outputFile}`);
  console.log("=".repeat(60));
}

// Запуск программы
if (require.main === module) {
  main().catch((error) => {
    console.error("Критическая ошибка:", error);
    process.exit(1);
  });
}

module.exports = {
  getPage,
  getAllLinks,
  parseQuestionPage,
  saveResults,
  loadExistingResults,
};
