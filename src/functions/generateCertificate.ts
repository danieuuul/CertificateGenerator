import { APIGatewayProxyHandler } from "aws-lambda";
import handlebars from 'handlebars';
import { join } from "path";
import { readFileSync } from 'fs';
import dayjs from "dayjs";
import type { Viewport } from 'puppeteer-core';
import chromium from 'chrome-aws-lambda';
import { S3 } from "aws-sdk";

import { document } from "../utils/dynamodbClient";

interface ICreateCertificate {
  id: string,
  name: string,
  grade: string
}

interface ITemplate {
  id: string,
  name: string,
  grade: string,
  medal: string,
  date: string
}

interface ILaunchOptions {
  args: string[];
  defaultViewport: Viewport;
  executablePath: string;
  headless: boolean;
  ignoreHTTPSErrors?: boolean;
}

const compile = async (data: ITemplate) => {
  const filePath = join(process.cwd(), "src", "templates", "certificate.hbs");

  const html = readFileSync(filePath, "utf-8");

  return handlebars.compile(html)(data)
}

export const handler: APIGatewayProxyHandler = async (event) => {
  const { id, name, grade } = JSON.parse(event.body) as ICreateCertificate;

  const response = await document.query({
    TableName: "users_certificate",
    KeyConditionExpression: "id = :id",
    ExpressionAttributeValues: {
      ":id": id,
    }
  }).promise();

  const userAlreadyExists = response.Items[0];

  if(!userAlreadyExists) {
    await document.put({
      TableName: "users_certificate",
      Item: {
        id, 
        name, 
        grade,
        created_at: new Date().getTime()
      }
    }).promise();
  }

  const medalPath = join(process.cwd(), "src", "templates", "selo.png");
  const medal = readFileSync(medalPath, "base64");

  const data: ITemplate = {
    name,
    id,
    grade,
    date: dayjs().format("DD/MM/YYYY"),
    medal
  }

  const content = await compile(data);

  let browser = null;
  try {
    const { args, headless, defaultViewport } = chromium;
    const executablePath = await chromium.executablePath;
  
    const commonOptions = { defaultViewport, executablePath };
  
    const options: ILaunchOptions = !process.env.IS_OFFLINE
      ? {
          args,
          headless,
          ignoreHTTPSErrors: true,
          ...commonOptions,          
        }
      : {
          args: [],
          headless: true,
          ...commonOptions,
        };
  
    browser = await chromium.puppeteer.launch(options);

    const page = await browser.newPage();
    await page.setContent(content);
    const pdf = await page.pdf({
      format: "a4",
      landscape: true,
      printBackground: true,
      preferCSSPageSize: true,
      path: process.env.IS_OFFLINE ? "./certificate.pdf" : null
    });

    const s3 = new S3();

    await s3.putObject({
      Bucket: "certificates-ignite-2022",
      Key: `${id}.pdf`,
      ACL: "public-read",
      Body: pdf,
      ContentType: "application/pdf"
    }).promise();


  } catch(err) {
    console.log(err);

    return {
      statusCode: 400,
      body: JSON.stringify("Erro")
    };
  } finally {
    if (browser !== null) await browser.close();
  }
  return {
    statusCode: 201,
    body: JSON.stringify({
      message: "Certificado criado com sucesso.",
      url: `https://certificates-ignite-2022.s3.amazonaws.com/${id}.pdf`
    })
  }
}